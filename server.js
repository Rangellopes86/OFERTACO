const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const MELI_REDIRECT_URI =
  "https://ofertaco.onrender.com/oauth/callback";

let oauthCodeVerifier = null;
let accessToken = null;

/*
=====================================================
POSTGRESQL
=====================================================
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/*
=====================================================
BANCO
=====================================================
*/

async function inicializarBanco() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id INTEGER PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("PostgreSQL conectado.");
    console.log("Tabela oauth_tokens verificada/criada.");

  } catch (erro) {
    console.error(
      "Erro ao inicializar PostgreSQL:",
      erro.message
    );
  }
}

/*
=====================================================
SALVAR TOKENS
=====================================================
*/

async function salvarTokens(dados) {
  try {
    const expiresAt =
      dados.expires_in
        ? Date.now() + Number(dados.expires_in) * 1000
        : null;

    await pool.query(
      `
      INSERT INTO oauth_tokens
      (
        id,
        access_token,
        refresh_token,
        expires_at,
        updated_at
      )
      VALUES
      (1, $1, $2, $3, CURRENT_TIMESTAMP)

      ON CONFLICT (id)
      DO UPDATE SET
        access_token = EXCLUDED.access_token,

        refresh_token =
          COALESCE(
            EXCLUDED.refresh_token,
            oauth_tokens.refresh_token
          ),

        expires_at = EXCLUDED.expires_at,

        updated_at = CURRENT_TIMESTAMP
      `,
      [
        dados.access_token,
        dados.refresh_token || null,
        expiresAt
      ]
    );

    accessToken = dados.access_token;

    console.log(
      "Tokens do Mercado Livre salvos no PostgreSQL."
    );

  } catch (erro) {
    console.error(
      "Erro ao salvar tokens:",
      erro.message
    );

    throw erro;
  }
}

/*
=====================================================
RENOVAR ACCESS TOKEN
=====================================================
*/

async function renovarAccessToken(refreshToken) {
  try {
    console.log(
      "Solicitando renovação do access_token..."
    );

    const resposta = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body: new URLSearchParams({
          grant_type: "refresh_token",

          client_id:
            process.env.MELI_CLIENT_ID,

          client_secret:
            process.env.MELI_CLIENT_SECRET,

          refresh_token:
            refreshToken
        })
      }
    );

    const dados = await resposta.json();

    console.log(
      "Resposta renovação OAuth:",
      {
        status: resposta.status,
        sucesso: !!dados.access_token
      }
    );

    if (
      !resposta.ok ||
      !dados.access_token
    ) {
      throw new Error(
        dados.message ||
        dados.error ||
        "Não foi possível renovar o access_token."
      );
    }

    await salvarTokens(dados);

    console.log(
      "Access token renovado com sucesso."
    );

    return true;

  } catch (erro) {
    console.error(
      "Erro ao renovar access_token:",
      erro.message
    );

    return false;
  }
}

/*
=====================================================
CARREGAR TOKENS
=====================================================
*/

async function carregarTokens() {
  try {
    const resultado = await pool.query(`
      SELECT
        access_token,
        refresh_token,
        expires_at
      FROM oauth_tokens
      WHERE id = 1
      LIMIT 1
    `);

    if (resultado.rows.length === 0) {
      console.log(
        "Nenhum token do Mercado Livre encontrado no banco."
      );

      return false;
    }

    const token = resultado.rows[0];

    accessToken = token.access_token;

    console.log(
      "Token do Mercado Livre carregado do PostgreSQL."
    );

    if (
      token.expires_at &&
      token.refresh_token
    ) {
      const faltam =
        Number(token.expires_at) - Date.now();

      if (faltam < 10 * 60 * 1000) {
        console.log(
          "Token próximo de expirar. Renovando..."
        );

        await renovarAccessToken(
          token.refresh_token
        );
      }
    }

    return true;

  } catch (erro) {
    console.error(
      "Erro ao carregar token do PostgreSQL:",
      erro.message
    );

    return false;
  }
}

/*
=====================================================
GARANTIR TOKEN
=====================================================
*/

async function garantirToken() {
  if (!accessToken) {
    await carregarTokens();
  }

  return !!accessToken;
}

/*
=====================================================
EXPRESS
=====================================================
*/

app.use(express.json());

app.use(
  express.static(__dirname)
);

/*
=====================================================
UTILITÁRIOS
=====================================================
*/

function gerarCodeVerifier() {
  return crypto
    .randomBytes(32)
    .toString("base64url");
}

function gerarCodeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

/*
=====================================================
ENCONTRAR IDs MLB
=====================================================
*/

function encontrarTodosIds(texto) {
  const valor = String(texto || "");

  const encontrados = [];

  /*
  MLB123456789
  */
  const padrao1 =
    /\bMLB\d{6,}\b/gi;

  /*
  MLB-123456789
  */
  const padrao2 =
    /\bMLB-\d{6,}\b/gi;

  /*
  URLs com item_id
  */
  const padrao3 =
    /item[_-]?id[=:\/"%\\\s]+(?:%22|")?(MLB-?\d{6,})/gi;

  /*
  IDs dentro de JSON
  */
  const padrao4 =
    /["'](?:id|item_id|itemId|catalog_product_id|product_id)["']\s*[:=]\s*["']?(MLB-?\d{6,})/gi;

  let resultado;

  while ((resultado = padrao1.exec(valor)) !== null) {
    encontrados.push(resultado[0]);
  }

  while ((resultado = padrao2.exec(valor)) !== null) {
    encontrados.push(resultado[0]);
  }

  while ((resultado = padrao3.exec(valor)) !== null) {
    encontrados.push(resultado[1]);
  }

  while ((resultado = padrao4.exec(valor)) !== null) {
    encontrados.push(resultado[1]);
  }

  return [
    ...new Set(
      encontrados.map(id =>
        id
          .replace(/-/g, "")
          .toUpperCase()
      )
    )
  ];
}

/*
=====================================================
ENCONTRAR USER PRODUCT
=====================================================
*/

function encontrarTodosUserProducts(texto) {
  const valor = String(texto || "");

  const resultados =
    valor.match(
      /\bMLBU\d{4,}\b/gi
    );

  if (!resultados) {
    return [];
  }

  return [
    ...new Set(
      resultados.map(id =>
        id.toUpperCase()
      )
    )
  ];
}

/*
=====================================================
EXTRAIR CATÁLOGO
=====================================================
*/

function extrairIdCatalogo(link) {
  const valor = String(link || "");

  const resultado =
    valor.match(
      /\/p\/(MLB\d{6,})/i
    );

  return resultado
    ? resultado[1].toUpperCase()
    : null;
}

/*
=====================================================
BAIXAR PÁGINA DO MERCADO LIVRE
=====================================================
*/

async function baixarPagina(url) {
  try {
    console.log(
      "Baixando página:",
      url
    );

    const resposta =
      await fetch(
        url,
        {
          method: "GET",

          redirect: "follow",

          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",

            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

            "Accept-Language":
              "pt-BR,pt;q=0.9"
          }
        }
      );

    const html =
      await resposta.text();

    console.log(
      "Página carregada:",
      {
        status: resposta.status,
        tamanhoHTML: html.length,
        urlFinal: resposta.url
      }
    );

    return {
      status: resposta.status,
      urlFinal: resposta.url,
      html
    };

  } catch (erro) {
    console.error(
      "Erro ao baixar página:",
      erro.message
    );

    return {
      status: 0,
      urlFinal: url,
      html: ""
    };
  }
}

/*
=====================================================
RESOLVER LINK CURTO
=====================================================
*/

async function resolverLink(link) {
  console.log(
    "Resolvendo link:",
    link
  );

  let urlAtual =
    String(link || "").trim();

  if (!urlAtual) {
    throw new Error("Link vazio.");
  }

  let html = "";

  for (
    let tentativa = 0;
    tentativa < 10;
    tentativa++
  ) {
    console.log(
      `Tentativa ${tentativa + 1}:`,
      urlAtual
    );

    let urlValida;

    try {
      urlValida =
        new URL(urlAtual);

    } catch (erroURL) {
      throw new Error(
        `URL inválida: ${urlAtual}`
      );
    }

    const resposta =
      await fetch(
        urlValida.toString(),
        {
          method: "GET",

          redirect: "manual",

          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",

            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

            "Accept-Language":
              "pt-BR,pt;q=0.9"
          }
        }
      );

    console.log(
      "Status:",
      resposta.status
    );

    const location =
      resposta.headers.get("location");

    if (
      resposta.status >= 300 &&
      resposta.status < 400 &&
      location
    ) {
      urlAtual =
        new URL(
          location,
          urlValida
        ).toString();

      continue;
    }

    try {
      html =
        await resposta.text();
    } catch {
      html = "";
    }

    return {
      status: resposta.status,
      urlFinal: urlValida.toString(),
      html
    };
  }

  throw new Error(
    "O link apresentou muitos redirecionamentos."
  );
}

/*
=====================================================
CONSULTAR ANÚNCIO MLB
=====================================================
*/

async function consultarAnuncio(idProduto) {
  console.log(
    "Consultando anúncio:",
    idProduto
  );

  /*
  Primeiro tenta autenticado.
  */

  try {
    let resposta =
      await fetch(
        `https://api.mercadolibre.com/items/${idProduto}`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            Accept:
              "application/json"
          }
        }
      );

    let dados =
      await resposta.json();

    console.log(
      "RESPOSTA ITEM AUTENTICADA:",
      {
        status: resposta.status,
        id: idProduto
      }
    );

    if (resposta.ok) {
      return {
        resposta,
        dados
      };
    }

    /*
    Se o token for recusado,
    tenta consulta pública.
    */

    if (
      resposta.status === 401 ||
      resposta.status === 403
    ) {
      console.log(
        "Consulta autenticada recusada. Tentando pública..."
      );

      resposta =
        await fetch(
          `https://api.mercadolibre.com/items/${idProduto}`,
          {
            headers: {
              Accept:
                "application/json"
            }
          }
        );

      dados =
        await resposta.json();

      console.log(
        "RESPOSTA ITEM PÚBLICA:",
        {
          status: resposta.status,
          id: idProduto
        }
      );

      return {
        resposta,
        dados
      };
    }

    return {
      resposta,
      dados
    };

  } catch (erro) {
    console.error(
      "Erro consultando anúncio:",
      erro.message
    );

    throw erro;
  }
}

/*
=====================================================
TENTAR DESCOBRIR MLB A PARTIR DO USER PRODUCT
=====================================================

IMPORTANTE:

Não usamos mais:

/user-products/MLBU...

porque esse endpoint pode retornar 403
"caller is not allowed to access this user product".

O MLBU será usado apenas para tentar localizar
a página pública correspondente.
=====================================================
*/

async function procurarMLBPorUserProduct(
  idUserProduct,
  linkOriginal
) {
  console.log(
    "Tentando localizar MLB a partir do User Product:",
    idUserProduct
  );

  const urls = [];

  /*
  Se o próprio link contém o MLBU,
  tentamos a página original.
  */

  if (
    linkOriginal &&
    linkOriginal.includes(idUserProduct)
  ) {
    urls.push(linkOriginal);
  }

  /*
  Tentativa de página pública do produto.
  */

  urls.push(
    `https://www.mercadolivre.com.br/p/${idUserProduct}`
  );

  urls.push(
    `https://produto.mercadolivre.com.br/${idUserProduct}`
  );

  for (
    const url of urls
  ) {
    try {
      const pagina =
        await baixarPagina(url);

      if (!pagina.html) {
        continue;
      }

      const ids =
        encontrarTodosIds(
          [
            pagina.urlFinal,
            pagina.html
          ].join("\n")
        );

      console.log(
        "MLBs encontrados nessa página:",
        ids
      );

      if (ids.length > 0) {
        return ids;
      }

    } catch (erro) {
      console.log(
        "Falha ao procurar MLB:",
        erro.message
      );
    }
  }

  return [];
}

/*
=====================================================
MONTAR DADOS DO ANÚNCIO
=====================================================
*/

function montarDadosAnuncio(
  dados,
  linkOriginal
) {
  const preco =
    Number(
      dados.price || 0
    );

  const precoAnterior =
    Number(
      dados.original_price || 0
    );

  const desconto =
    precoAnterior > preco &&
    preco > 0
      ? Math.round(
          (
            1 -
            preco /
              precoAnterior
          ) * 100
        )
      : 0;

  const imagem =
    dados.pictures?.[0]?.url ||
    dados.pictures?.[0]?.secure_url ||
    dados.thumbnail ||
    "";

  return {
    id:
      dados.id,

    titulo:
      dados.title ||
      "Produto do Mercado Livre",

    imagem,

    preco,

    precoAnterior:
      precoAnterior > preco
        ? precoAnterior
        : null,

    desconto,

    linkAfiliado:
      linkOriginal,

    linkFinal:
      linkOriginal
  };
}

/*
=====================================================
OAUTH - AUTORIZAÇÃO
=====================================================
*/

app.get(
  "/oauth/authorize",
  (req, res) => {
    try {
      const verifier =
        gerarCodeVerifier();

      const challenge =
        gerarCodeChallenge(
          verifier
        );

      oauthCodeVerifier =
        verifier;

      const params =
        new URLSearchParams({
          response_type:
            "code",

          client_id:
            process.env.MELI_CLIENT_ID,

          redirect_uri:
            MELI_REDIRECT_URI,

          code_challenge:
            challenge,

          code_challenge_method:
            "S256"
        });

      res.redirect(
        "https://auth.mercadolivre.com.br/authorization?" +
        params.toString()
      );

    } catch (erro) {
      console.error(
        "Erro ao iniciar OAuth:",
        erro.message
      );

      res.status(500).send(
        "<h2>Erro no OAuth</h2><p>Não foi possível iniciar a autorização.</p>"
      );
    }
  }
);

/*
=====================================================
OAUTH CALLBACK
=====================================================
*/

app.get(
  "/oauth/callback",
  async (req, res) => {
    try {
      const code =
        req.query.code;

      if (!code) {
        return res
          .status(400)
          .send(`
            <h2>Erro no OAuth</h2>
            <p>Nenhum código de autorização foi recebido.</p>
          `);
      }

      if (!oauthCodeVerifier) {
        return res
          .status(400)
          .send(`
            <h2>Erro no OAuth</h2>
            <p>O code_verifier não está disponível.</p>
          `);
      }

      const resposta =
        await fetch(
          "https://api.mercadolibre.com/oauth/token",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded"
            },

            body:
              new URLSearchParams({
                grant_type:
                  "authorization_code",

                client_id:
                  process.env.MELI_CLIENT_ID,

                client_secret:
                  process.env.MELI_CLIENT_SECRET,

                code,

                redirect_uri:
                  MELI_REDIRECT_URI,

                code_verifier:
                  oauthCodeVerifier
              })
          }
        );

      const dados =
        await resposta.json();

      console.log(
        "Resposta OAuth:",
        {
          status:
            resposta.status,

          sucesso:
            !!dados.access_token,

          possuiRefreshToken:
            !!dados.refresh_token
        }
      );

      if (
        !resposta.ok ||
        !dados.access_token
      ) {
        return res
          .status(400)
          .send(`
            <h2>Erro ao obter autorização</h2>
            <p>O Mercado Livre não devolveu o token de acesso.</p>
            <p>Status: ${resposta.status}</p>
          `);
      }

      await salvarTokens(dados);

      oauthCodeVerifier =
        null;

      res.send(`
        <h2>Ofertaço conectado com sucesso! 🎉</h2>
        <p>A conta do Mercado Livre foi autorizada.</p>
        <p>A autorização foi salva no banco de dados.</p>
        <p>Você já pode voltar ao Ofertaço.</p>
      `);

    } catch (erro) {
      console.error(
        "Erro OAuth:",
        erro.message
      );

      res.status(500).send(`
        <h2>Erro no OAuth</h2>
        <p>Não foi possível concluir a autorização.</p>
        <p>${erro.message}</p>
      `);
    }
  }
);

/*
=====================================================
API DO PRODUTO
=====================================================
*/

app.post(
  "/api/product",
  async (req, res) => {
    try {
      const linkOriginal =
        String(
          req.body?.url || ""
        ).trim();

      if (!linkOriginal) {
        return res.status(400).json({
          error:
            "Cole o link do Mercado Livre."
        });
      }

      const conectado =
        await garantirToken();

      if (!conectado) {
        return res.status(401).json({
          error:
            "O Ofertaço ainda não está conectado ao Mercado Livre."
        });
      }

      console.log(
        "================================================"
      );

      console.log(
        "LINK RECEBIDO:",
        linkOriginal
      );

      /*
      =================================================
      1. RESOLVER LINK
      =================================================
      */

      let linkFinal =
        linkOriginal;

      let htmlResolvido =
        "";

      try {
        const resultado =
          await resolverLink(
            linkOriginal
          );

        linkFinal =
          resultado.urlFinal;

        htmlResolvido =
          resultado.html;

        console.log(
          "URL FINAL:",
          linkFinal
        );

      } catch (erroLink) {
        console.log(
          "Não foi possível resolver o link diretamente:",
          erroLink.message
        );
      }

      /*
      =================================================
      2. ANALISAR TUDO QUE JÁ TEMOS
      =================================================
      */

      let textoAnalise =
        [
          linkOriginal,
          linkFinal,
          htmlResolvido
        ].join("\n");

      /*
      =================================================
      3. PROCURAR MLB
      =================================================
      */

      let idsEncontrados =
        encontrarTodosIds(
          textoAnalise
        );

      console.log(
        "MLBs encontrados inicialmente:",
        idsEncontrados
      );

      /*
      =================================================
      4. SE JÁ TEM MLB, TESTAR
      =================================================
      */

      for (
        const idProduto of idsEncontrados
      ) {
        try {
          const resultado =
            await consultarAnuncio(
              idProduto
            );

          if (
            resultado.resposta.ok &&
            resultado.dados?.id
          ) {
            console.log(
              "ANÚNCIO ENCONTRADO:",
              idProduto
            );

            return res.json(
              montarDadosAnuncio(
                resultado.dados,
                linkOriginal
              )
            );
          }

        } catch (erroItem) {
          console.log(
            `Erro consultando ${idProduto}:`,
            erroItem.message
          );
        }
      }

      /*
      =================================================
      5. PROCURAR USER PRODUCT
      =================================================
      */

      const userProducts =
        encontrarTodosUserProducts(
          textoAnalise
        );

      console.log(
        "USER PRODUCTS ENCONTRADOS:",
        userProducts
      );

      /*
      =================================================
      6. USER PRODUCT -> TENTAR DESCOBRIR MLB
      =================================================
      */

      for (
        const idUserProduct of userProducts
      ) {
        try {
          const mlbs =
            await procurarMLBPorUserProduct(
              idUserProduct,
              linkOriginal
            );

          console.log(
            `MLBs encontrados para ${idUserProduct}:`,
            mlbs
          );

          for (
            const idProduto of mlbs
          ) {
            if (
              idsEncontrados.includes(
                idProduto
              )
            ) {
              continue;
            }

            try {
              const resultado =
                await consultarAnuncio(
                  idProduto
                );

              if (
                resultado.resposta.ok &&
                resultado.dados?.id
              ) {
                console.log(
                  "ANÚNCIO ENCONTRADO VIA USER PRODUCT:",
                  idProduto
                );

                return res.json(
                  montarDadosAnuncio(
                    resultado.dados,
                    linkOriginal
                  )
                );
              }

            } catch (erroItem) {
              console.log(
                `Erro consultando MLB ${idProduto}:`,
                erroItem.message
              );
            }
          }

        } catch (erroUP) {
          console.log(
            `Erro procurando MLB pelo User Product ${idUserProduct}:`,
            erroUP.message
          );
        }
      }

      /*
      =================================================
      7. TENTAR PÁGINA FINAL NOVAMENTE
      =================================================
      */

      if (linkFinal) {
        try {
          const pagina =
            await baixarPagina(
              linkFinal
            );

          const novosIds =
            encontrarTodosIds(
              [
                linkFinal,
                pagina.urlFinal,
                pagina.html
              ].join("\n")
            );

          console.log(
            "MLBs encontrados na página final:",
            novosIds
          );

          for (
            const idProduto of novosIds
          ) {
            try {
              const resultado =
                await consultarAnuncio(
                  idProduto
                );

              if (
                resultado.resposta.ok &&
                resultado.dados?.id
              ) {
                return res.json(
                  montarDadosAnuncio(
                    resultado.dados,
                    linkOriginal
                  )
                );
              }

            } catch (erroItem) {
              console.log(
                "Erro consultando MLB:",
                erroItem.message
              );
            }
          }

        } catch (erroPagina) {
          console.log(
            "Erro ao analisar página final:",
            erroPagina.message
          );
        }
      }

      /*
      =================================================
      8. CATÁLOGO
      =================================================
      */

      const idCatalogo =
        extrairIdCatalogo(
          linkFinal
        );

      console.log(
        "ID CATÁLOGO:",
        idCatalogo
      );

      if (idCatalogo) {
        try {
          const respostaProduto =
            await fetch(
              `https://api.mercadolibre.com/products/${idCatalogo}`,
              {
                headers: {
                  Authorization:
                    `Bearer ${accessToken}`,

                  Accept:
                    "application/json"
                }
              }
            );

          const produto =
            await respostaProduto.json();

          console.log(
            "RESPOSTA PRODUCTS:",
            {
              status:
                respostaProduto.status
            }
          );

          if (respostaProduto.ok) {
            let imagem =
              produto.pictures?.[0]?.url ||
              produto.pictures?.[0]?.secure_url ||
              "";

            let titulo =
              produto.name ||
              produto.title ||
              "Produto do Mercado Livre";

            let preco = 0;
            let precoAnterior = 0;
            let idAnuncio = null;

            /*
            Procura IDs MLB dentro da resposta do catálogo.
            */

            const idsCatalogo =
              encontrarTodosIds(
                JSON.stringify(produto)
              );

            for (
              const id of idsCatalogo
            ) {
              try {
                const resultado =
                  await consultarAnuncio(
                    id
                  );

                if (
                  resultado.resposta.ok
                ) {
                  idAnuncio = id;

                  preco =
                    Number(
                      resultado.dados.price ||
                      0
                    );

                  precoAnterior =
                    Number(
                      resultado.dados.original_price ||
                      0
                    );

                  if (!imagem) {
                    imagem =
                      resultado.dados.pictures?.[0]?.url ||
                      resultado.dados.thumbnail ||
                      "";
                  }

                  if (
                    !titulo ||
                    titulo ===
                      "Produto do Mercado Livre"
                  ) {
                    titulo =
                      resultado.dados.title ||
                      titulo;
                  }

                  break;
                }

              } catch {}
            }

            const desconto =
              precoAnterior > preco &&
              preco > 0
                ? Math.round(
                    (
                      1 -
                      preco /
                        precoAnterior
                    ) * 100
                  )
                : 0;

            return res.json({
              id:
                idAnuncio ||
                idCatalogo,

              titulo,

              imagem,

              preco,

              precoAnterior:
                precoAnterior > preco
                  ? precoAnterior
                  : null,

              desconto,

              linkAfiliado:
                linkOriginal,

              linkFinal:
                linkOriginal
            });
          }

        } catch (erroCatalogo) {
          console.log(
            "Erro catálogo:",
            erroCatalogo.message
          );
        }
      }

      /*
      =================================================
      9. ERRO FINAL
      =================================================
      */

      if (
        userProducts.length > 0
      ) {
        return res.status(422).json({
          error:
            "O link contém um User Product do Mercado Livre, mas não foi possível localizar o anúncio MLB correspondente.",

          detalhe:
            "O Mercado Livre bloqueou o acesso direto ao User Product e o anúncio MLB não apareceu na página analisada."
        });
      }

      return res.status(422).json({
        error:
          "Não consegui identificar o produto nesse link.",

        detalhe:
          "Nenhum anúncio MLB pôde ser localizado no link ou na página do Mercado Livre."
      });

    } catch (erro) {
      console.error(
        "ERRO API PRODUTO:",
        erro
      );

      return res.status(500).json({
        error:
          "Não foi possível consultar o produto.",

        detalhe:
          erro.message
      });
    }
  }
);

/*
=====================================================
HEALTH
=====================================================
*/

app.get(
  "/health",
  async (req, res) => {
    let conectado = false;
    let banco = false;

    try {
      conectado =
        await garantirToken();
    } catch {
      conectado = false;
    }

    try {
      await pool.query(
        "SELECT 1"
      );

      banco = true;

    } catch {
      banco = false;
    }

    res.json({
      status:
        "OK",

      ofertaco:
        "online",

      mercadoLivre:
        conectado,

      banco
    });
  }
);

/*
=====================================================
INICIALIZAÇÃO
=====================================================
*/

async function iniciarServidor() {
  await inicializarBanco();

  await carregarTokens();

  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `Ofertaço iniciado na porta ${PORT}`
      );

      console.log(
        "PostgreSQL:",
        process.env.DATABASE_URL
          ? "configurado"
          : "não configurado"
      );

      console.log(
        "Mercado Livre:",
        accessToken
          ? "token carregado"
          : "aguardando autorização"
      );
    }
  );
}

iniciarServidor();
