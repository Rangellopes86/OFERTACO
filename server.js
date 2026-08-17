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
====================================================
POSTGRESQL
====================================================
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/*
====================================================
BANCO
====================================================
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
====================================================
SALVAR TOKENS
====================================================
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

        access_token =
          EXCLUDED.access_token,

        refresh_token =
          COALESCE(
            EXCLUDED.refresh_token,
            oauth_tokens.refresh_token
          ),

        expires_at =
          EXCLUDED.expires_at,

        updated_at =
          CURRENT_TIMESTAMP
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
====================================================
RENOVAR ACCESS TOKEN
====================================================
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
====================================================
CARREGAR TOKENS
====================================================
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

    if (
      resultado.rows.length === 0
    ) {
      console.log(
        "Nenhum token do Mercado Livre encontrado no banco."
      );

      return false;
    }

    const token = resultado.rows[0];

    accessToken =
      token.access_token;

    console.log(
      "Token do Mercado Livre carregado do PostgreSQL."
    );

    if (
      token.expires_at &&
      token.refresh_token
    ) {
      const faltam =
        Number(token.expires_at) -
        Date.now();

      if (
        faltam < 10 * 60 * 1000
      ) {
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
====================================================
GARANTIR TOKEN
====================================================
*/

async function garantirToken() {
  if (!accessToken) {
    await carregarTokens();
  }

  return !!accessToken;
}

/*
====================================================
EXPRESS
====================================================
*/

app.use(express.json());

app.use(
  express.static(__dirname)
);

/*
====================================================
UTILITÁRIOS
====================================================
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
====================================================
ENCONTRAR TODOS OS IDs MLB
====================================================
*/

function encontrarTodosIds(texto) {
  const valor =
    String(texto || "");

  const resultados =
    valor.match(
      /\bMLB\d{6,}\b/gi
    );

  if (!resultados) {
    return [];
  }

  return [
    ...new Set(
      resultados.map(
        id => id.toUpperCase()
      )
    )
  ];
}

/*
====================================================
ENCONTRAR USER PRODUCTS MLBU
====================================================
*/

function encontrarTodosUserProducts(texto) {
  const valor =
    String(texto || "");

  const resultados =
    valor.match(
      /\bMLBU\d{4,}\b/gi
    );

  if (!resultados) {
    return [];
  }

  return [
    ...new Set(
      resultados.map(
        id => id.toUpperCase()
      )
    )
  ];
}

/*
====================================================
EXTRAIR ID DE CATÁLOGO
====================================================
*/

function extrairIdCatalogo(link) {
  const valor =
    String(link || "");

  const resultado =
    valor.match(
      /\/p\/(MLB\d{6,})/i
    );

  return resultado
    ? resultado[1].toUpperCase()
    : null;
}

/*
====================================================
RESOLVER LINK
====================================================
*/

async function resolverLink(link) {
  console.log(
    "Resolvendo link:",
    link
  );

  let urlAtual =
    String(link || "").trim();

  if (!urlAtual) {
    throw new Error(
      "Link vazio."
    );
  }

  let html = "";
  let statusFinal = 0;

  for (
    let tentativa = 0;
    tentativa < 10;
    tentativa++
  ) {
    console.log(
      `Tentativa de redirecionamento ${tentativa + 1}:`,
      urlAtual
    );

    let urlValida;

    try {
      urlValida =
        new URL(urlAtual);

    } catch {
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
              "Mozilla/5.0",

            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

            "Accept-Language":
              "pt-BR,pt;q=0.9"
          }
        }
      );

    statusFinal =
      resposta.status;

    console.log(
      "Status:",
      resposta.status
    );

    const location =
      resposta.headers.get(
        "location"
      );

    if (
      resposta.status >= 300 &&
      resposta.status < 400 &&
      location
    ) {
      const proximaURL =
        new URL(
          location,
          urlValida
        ).toString();

      console.log(
        "Redirecionando para:",
        proximaURL
      );

      urlAtual =
        proximaURL;

      continue;
    }

    try {
      html =
        await resposta.text();

    } catch (erroTexto) {
      console.log(
        "Erro ao ler HTML:",
        erroTexto.message
      );

      html = "";
    }

    console.log(
      "URL final:",
      urlValida.toString()
    );

    return {
      status: statusFinal,
      urlFinal:
        urlValida.toString(),
      html
    };
  }

  throw new Error(
    "O link apresentou muitos redirecionamentos."
  );
}

/*
====================================================
CONSULTAR ANÚNCIO MLB
====================================================
*/

async function consultarAnuncio(idProduto) {
  console.log(
    "Consultando anúncio:",
    idProduto
  );

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
      status:
        resposta.status,

      dados
    }
  );

  /*
  Tenta consulta pública caso a
  consulta autenticada seja recusada.
  */

  if (
    resposta.status === 401 ||
    resposta.status === 403
  ) {
    console.log(
      "Consulta autenticada recusada. Tentando consulta pública..."
    );

    try {
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
          status:
            resposta.status,

          dados
        }
      );

    } catch (erroPublico) {
      console.error(
        "Erro na consulta pública:",
        erroPublico.message
      );
    }
  }

  return {
    resposta,
    dados
  };
}

/*
====================================================
CONSULTAR USER PRODUCT
====================================================
*/

async function consultarUserProduct(
  idUserProduct
) {
  console.log(
    "Consultando User Product:",
    idUserProduct
  );

  const resposta =
    await fetch(
      `https://api.mercadolibre.com/user-products/${idUserProduct}`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          Accept:
            "application/json"
        }
      }
    );

  const dados =
    await resposta.json();

  console.log(
    "RESPOSTA USER PRODUCT:",
    {
      status:
        resposta.status,

      dados
    }
  );

  return {
    resposta,
    dados
  };
}

/*
====================================================
BUSCAR ANÚNCIOS DO USER PRODUCT
====================================================
*/

async function buscarAnunciosDoUserProduct(
  idUserProduct,
  sellerId
) {
  if (!idUserProduct) {
    console.log(
      "User Product ID não informado."
    );

    return [];
  }

  if (!sellerId) {
    console.log(
      "Seller ID não informado."
    );

    return [];
  }

  const url =
    `https://api.mercadolibre.com/users/${sellerId}/items/search?user_product_id=${encodeURIComponent(
      idUserProduct
    )}`;

  console.log(
    "BUSCANDO ANÚNCIOS DO USER PRODUCT:",
    {
      idUserProduct,
      sellerId,
      url
    }
  );

  try {
    const resposta =
      await fetch(
        url,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            Accept:
              "application/json"
          }
        }
      );

    const texto =
      await resposta.text();

    let dados = {};

    try {
      dados =
        JSON.parse(texto);

    } catch {
      console.log(
        "Resposta da busca não veio em JSON:",
        texto
      );

      return [];
    }

    console.log(
      "RESPOSTA BUSCA USER PRODUCT:",
      {
        status:
          resposta.status,

        ok:
          resposta.ok,

        dados
      }
    );

    if (!resposta.ok) {
      return [];
    }

    if (
      Array.isArray(
        dados.results
      )
    ) {
      return dados.results;
    }

    return [];

  } catch (erro) {
    console.error(
      "Erro ao buscar anúncios do User Product:",
      erro.message
    );

    return [];
  }
}

/*
====================================================
MONTAR DADOS DO ANÚNCIO
====================================================
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
====================================================
OAUTH - AUTORIZAÇÃO
====================================================
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
        erro
      );

      res.status(500).send(
        "<h2>Erro no OAuth</h2>"
      );
    }
  }
);

/*
====================================================
OAUTH - CALLBACK
====================================================
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

      await salvarTokens(
        dados
      );

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
        erro
      );

      res.status(500).send(`
        <h2>Erro no OAuth</h2>
        <p>${erro.message}</p>
      `);
    }
  }
);

/*
====================================================
API DO PRODUTO
====================================================
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
      1. LINK
      =================================================
      */

      let linkFinal =
        linkOriginal;

      let htmlResolvido =
        "";

      /*
      Detecta links meli.la.
      */

      if (
        linkOriginal
          .toLowerCase()
          .includes("meli.la/")
      ) {
        try {

          const resolvido =
            await resolverLink(
              linkOriginal
            );

          linkFinal =
            resolvido.urlFinal;

          htmlResolvido =
            resolvido.html;

        } catch (erroLink) {

          console.error(
            "Erro ao resolver meli.la:",
            erroLink.message
          );

          return res.status(400).json({
            error:
              "Não foi possível abrir o link do Mercado Livre.",

            detalhe:
              erroLink.message
          });
        }
      }

      /*
      =================================================
      2. TEXTO PARA IDENTIFICAÇÃO
      =================================================
      */

      const textoInicial =
        [
          linkOriginal,
          linkFinal,
          htmlResolvido
        ].join("\n");

      /*
      =================================================
      3. USER PRODUCT MLBU
      =================================================
      */

      const userProducts =
        encontrarTodosUserProducts(
          textoInicial
        );

      console.log(
        "================================================"
      );

      console.log(
        "USER PRODUCTS ENCONTRADOS:",
        userProducts
      );

      /*
      =================================================
      PROCESSAR CADA MLBU
      =================================================
      */

      if (
        userProducts.length > 0
      ) {

        for (
          const idUserProduct of userProducts
        ) {

          try {

            console.log(
              "PROCESSANDO USER PRODUCT:",
              idUserProduct
            );

            /*
            -----------------------------------------
            CONSULTAR USER PRODUCT
            -----------------------------------------
            */

            const resultadoUP =
              await consultarUserProduct(
                idUserProduct
              );

            if (
              !resultadoUP.resposta.ok
            ) {

              console.log(
                "Não foi possível consultar o User Product.",
                resultadoUP.resposta.status
              );

              continue;
            }

            const dadosUP =
              resultadoUP.dados;

            console.log(
              "DADOS DO USER PRODUCT:",
              dadosUP
            );

            /*
            -----------------------------------------
            IDENTIFICAR SELLER
            -----------------------------------------
            */

            const sellerId =
              dadosUP.user_id ||
              dadosUP.seller_id ||
              dadosUP.user?.id ||
              dadosUP.seller?.id ||
              null;

            console.log(
              "SELLER ID:",
              sellerId
            );

            /*
            -----------------------------------------
            PROCURAR MLB DIRETAMENTE NA RESPOSTA
            -----------------------------------------
            */

            const idsDiretos =
              encontrarTodosIds(
                JSON.stringify(
                  dadosUP
                )
              );

            console.log(
              "MLBs ENCONTRADOS NO USER PRODUCT:",
              idsDiretos
            );

            /*
            -----------------------------------------
            CONSULTAR MLB DIRETO
            -----------------------------------------
            */

            for (
              const idAnuncio of idsDiretos
            ) {

              try {

                const resultadoItem =
                  await consultarAnuncio(
                    idAnuncio
                  );

                if (
                  resultadoItem.resposta.ok
                ) {

                  console.log(
                    "ANÚNCIO ENCONTRADO:",
                    idAnuncio
                  );

                  return res.json(
                    montarDadosAnuncio(
                      resultadoItem.dados,
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

            /*
            -----------------------------------------
            BUSCAR ITENS PELO USER PRODUCT
            -----------------------------------------
            */

            if (sellerId) {

              const anuncios =
                await buscarAnunciosDoUserProduct(
                  idUserProduct,
                  sellerId
                );

              console.log(
                "ANÚNCIOS ASSOCIADOS:",
                anuncios
              );

              /*
              ---------------------------------------
              TESTAR CADA MLB ENCONTRADO
              ---------------------------------------
              */

              for (
                const idAnuncio of anuncios
              ) {

                if (!idAnuncio) {
                  continue;
                }

                try {

                  const resultadoItem =
                    await consultarAnuncio(
                      idAnuncio
                    );

                  if (
                    resultadoItem.resposta.ok
                  ) {

                    console.log(
                      "ANÚNCIO ENCONTRADO VIA USER PRODUCT:",
                      idAnuncio
                    );

                    return res.json(
                      montarDadosAnuncio(
                        resultadoItem.dados,
                        linkOriginal
                      )
                    );
                  }

                } catch (erroItem) {

                  console.log(
                    `Erro consultando ${idAnuncio}:`,
                    erroItem.message
                  );
                }
              }

            } else {

              console.log(
                "USER PRODUCT NÃO INFORMOU seller_id."
              );
            }

          } catch (erroUP) {

            console.error(
              `Erro processando ${idUserProduct}:`,
              erroUP.message
            );
          }
        }
      }

      /*
      =================================================
      4. CATÁLOGO
      =================================================
      */

      const idCatalogo =
        extrairIdCatalogo(
          linkFinal
        );

      console.log(
        "ID DE CATÁLOGO:",
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

          if (
            respostaProduto.ok
          ) {

            const titulo =
              produto.name ||
              produto.title ||
              "Produto do Mercado Livre";

            let imagem = "";

            if (
              Array.isArray(
                produto.pictures
              ) &&
              produto.pictures.length
            ) {

              imagem =
                produto.pictures[0].url ||
                produto.pictures[0].secure_url ||
                "";
            }

            /*
            -----------------------------------------
            BUSCAR ITENS DO CATÁLOGO
            -----------------------------------------
            */

            const respostaItens =
              await fetch(
                `https://api.mercadolibre.com/products/${idCatalogo}/items`,
                {
                  headers: {
                    Authorization:
                      `Bearer ${accessToken}`,

                    Accept:
                      "application/json"
                  }
                }
              );

            const dadosItens =
              await respostaItens.json();

            let anuncios = [];

            if (
              Array.isArray(
                dadosItens
              )
            ) {

              anuncios =
                dadosItens;

            } else if (
              Array.isArray(
                dadosItens.results
              )
            ) {

              anuncios =
                dadosItens.results;
            }

            const primeiro =
              anuncios[0] ||
              null;

            const idAnuncio =
              primeiro?.item_id ||
              primeiro?.id ||
              null;

            if (idAnuncio) {

              const resultadoItem =
                await consultarAnuncio(
                  idAnuncio
                );

              if (
                resultadoItem.resposta.ok
              ) {

                return res.json(
                  montarDadosAnuncio(
                    resultadoItem.dados,
                    linkOriginal
                  )
                );
              }
            }

            return res.json({
              id:
                idCatalogo,

              titulo,

              imagem,

              preco:
                Number(
                  primeiro?.price || 0
                ),

              precoAnterior:
                null,

              desconto:
                0,

              linkAfiliado:
                linkOriginal,

              linkFinal:
                linkOriginal
            });
          }

        } catch (erroCatalogo) {

          console.error(
            "Erro no catálogo:",
            erroCatalogo.message
          );
        }
      }

      /*
      =================================================
      5. PROCURAR MLB NO LINK/HTML
      =================================================
      */

      const idsEncontrados =
        encontrarTodosIds(
          [
            linkOriginal,
            linkFinal,
            htmlResolvido
          ].join("\n")
        );

      console.log(
        "MLBs ENCONTRADOS:",
        idsEncontrados
      );

      /*
      =================================================
      6. CONSULTAR MLB
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
            resultado.resposta.ok
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
      7. ERRO FINAL
      =================================================
      */

      if (
        userProducts.length > 0
      ) {

        return res.status(403).json({

          error:
            "O Mercado Livre identificou o User Product, mas não foi possível localizar um anúncio MLB associado.",

          userProduct:
            userProducts[0],

          detalhe:
            "O Ofertaço consultou o User Product e tentou localizar os anúncios associados."
        });
      }

      return res.status(422).json({

        error:
          "Não consegui identificar o produto nesse link.",

        detalhe:
          "Nenhum ID MLB ou MLBU foi encontrado."
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
====================================================
HEALTH
====================================================
*/

app.get(
  "/health",
  async (req, res) => {

    let conectado =
      false;

    try {

      conectado =
        await garantirToken();

    } catch {

      conectado =
        false;
    }

    res.json({

      status:
        "OK",

      ofertaco:
        "online",

      mercadoLivre:
        conectado,

      banco:
        !!process.env.DATABASE_URL
    });
  }
);

/*
====================================================
INICIALIZAÇÃO
====================================================
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
