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

        const renovado =
          await renovarAccessToken(
            token.refresh_token
          );

        if (!renovado) {
          console.log(
            "Não foi possível renovar o token."
          );
        }
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

  const resultados =
    valor.match(/\bMLB\d{6,}\b/gi);

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
=====================================================
ENCONTRAR USER PRODUCTS MLBU
=====================================================
*/

function encontrarTodosUserProducts(texto) {
  const valor = String(texto || "");

  const resultados =
    valor.match(/\bMLBU\d{4,}\b/gi);

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
=====================================================
EXTRAIR CATÁLOGO
=====================================================
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
=====================================================
RESOLVER LINK
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

    statusFinal =
      resposta.status;

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
=====================================================
CONSULTAR ANÚNCIO MLB
=====================================================
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

      id:
        dados?.id,

      titulo:
        dados?.title
    }
  );

  /*
  Se o token for recusado,
  tenta consulta pública.
  */

  if (
    resposta.status === 401 ||
    resposta.status === 403
  ) {
    console.log(
      "Token recusado para o anúncio. Tentando consulta pública..."
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

          id:
            dados?.id,

          titulo:
            dados?.title
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
=====================================================
CONSULTAR USER PRODUCT
=====================================================

IMPORTANTE:

O Mercado Livre pode devolver 403 aqui.

Isso NÃO deve interromper o processamento.

=====================================================
*/

async function consultarUserProduct(
  idUserProduct
) {
  console.log(
    "Consultando User Product:",
    idUserProduct
  );

  try {
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

  } catch (erro) {
    console.error(
      "Erro ao consultar User Product:",
      erro.message
    );

    return {
      resposta: {
        ok: false,
        status: 0
      },

      dados: {}
    };
  }
}

/*
=====================================================
BUSCAR ANÚNCIOS PELO USER PRODUCT
=====================================================

Essa é a rota oficial documentada pelo Mercado Livre.

=====================================================
*/

async function buscarAnunciosDoUserProduct(
  idUserProduct,
  sellerId
) {
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
    "BUSCANDO MLB PELO MLBU:",
    url
  );

  try {
    const resposta =
      await fetch(
        url,
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
      "RESPOSTA BUSCA MLB PELO MLBU:",
      {
        status:
          resposta.status,

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
      "Erro buscando anúncios pelo User Product:",
      erro.message
    );

    return [];
  }
}

/*
=====================================================
EXTRAIR MLB DE QUALQUER OBJETO
=====================================================
*/

function encontrarMLBsEmObjeto(objeto) {
  try {
    return encontrarTodosIds(
      JSON.stringify(objeto)
    );
  } catch (erro) {
    return [];
  }
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
    dados.thumbnail ||
    "";

  console.log(
    "DADOS FINAIS DO ANÚNCIO:",
    {
      id:
        dados.id,

      titulo:
        dados.title,

      preco,

      precoAnterior,

      desconto
    }
  );

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
PROCESSAR MLBS
=====================================================
*/

async function tentarMLBs(
  ids,
  linkOriginal
) {
  const idsUnicos = [
    ...new Set(
      ids
        .map(
          id =>
            String(id).toUpperCase()
        )
        .filter(
          id =>
            /^MLB\d{6,}$/.test(id)
        )
    )
  ];

  console.log(
    "MLBs PARA TESTAR:",
    idsUnicos
  );

  for (
    const idProduto of idsUnicos
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

        return montarDadosAnuncio(
          resultado.dados,
          linkOriginal
        );
      }

      console.log(
        `MLB ${idProduto} não retornou anúncio válido. Status: ${resultado.resposta.status}`
      );

    } catch (erro) {
      console.log(
        `Erro consultando ${idProduto}:`,
        erro.message
      );
    }
  }

  return null;
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
        erro
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

      await salvarTokens(
        dados
      );

      oauthCodeVerifier =
        null;

      console.log(
        "OAuth conectado e salvo no PostgreSQL."
      );

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
        "NOVO PRODUTO RECEBIDO"
      );

      console.log(
        "LINK ORIGINAL:",
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

      if (
        linkOriginal
          .toLowerCase()
          .includes("meli.la/")
      ) {
        console.log(
          "Link meli.la detectado."
        );

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
            "Erro resolvendo link:",
            erroLink.message
          );
        }
      }

      console.log(
        "LINK FINAL:",
        linkFinal
      );

      /*
      =================================================
      2. PROCURAR MLB DIRETO NO LINK
      =================================================
      */

      const idsDiretos =
        encontrarTodosIds(
          linkFinal
        );

      console.log(
        "MLBs ENCONTRADOS DIRETAMENTE NO LINK:",
        idsDiretos
      );

      const resultadoDireto =
        await tentarMLBs(
          idsDiretos,
          linkOriginal
        );

      if (resultadoDireto) {
        return res.json(
          resultadoDireto
        );
      }

      /*
      =================================================
      3. PROCURAR MLBU
      =================================================
      */

      const textoInicial =
        [
          linkFinal,
          htmlResolvido
        ].join("\n");

      const userProducts =
        encontrarTodosUserProducts(
          textoInicial
        );

      console.log(
        "MLBUs ENCONTRADOS:",
        userProducts
      );

      /*
      =================================================
      4. PROCESSAR CADA MLBU
      =================================================
      */

      for (
        const idUserProduct of userProducts
      ) {
        console.log(
          "PROCESSANDO MLBU:",
          idUserProduct
        );

        /*
        Primeiro tenta consultar o User Product.
        Se retornar 403, simplesmente continua.
        */

        const resultadoUP =
          await consultarUserProduct(
            idUserProduct
          );

        let dadosUP =
          resultadoUP.dados || {};

        /*
        Procura qualquer MLB que tenha vindo
        dentro da resposta do User Product.
        */

        const mlbsNoUP =
          encontrarMLBsEmObjeto(
            dadosUP
          );

        console.log(
          "MLBs ENCONTRADOS NA RESPOSTA DO MLBU:",
          mlbsNoUP
        );

        const resultadoUPMLB =
          await tentarMLBs(
            mlbsNoUP,
            linkOriginal
          );

        if (resultadoUPMLB) {
          return res.json(
            resultadoUPMLB
          );
        }

        /*
        =================================================
        5. DESCOBRIR SELLER ID
        =================================================
        */

        const sellerId =
          dadosUP.user_id ||
          dadosUP.seller_id ||
          dadosUP.user?.id ||
          dadosUP.seller?.id ||
          null;

        console.log(
          "SELLER ID ENCONTRADO:",
          sellerId
        );

        /*
        Se o endpoint de User Product retornou
        403, pode não existir seller_id.
        Nesse caso não podemos fazer essa busca.
        */

        if (sellerId) {
          const idsAnuncios =
            await buscarAnunciosDoUserProduct(
              idUserProduct,
              sellerId
            );

          console.log(
            "MLBs ASSOCIADOS AO MLBU:",
            idsAnuncios
          );

          const resultadoBusca =
            await tentarMLBs(
              idsAnuncios,
              linkOriginal
            );

          if (resultadoBusca) {
            return res.json(
              resultadoBusca
            );
          }
        } else {
          console.log(
            "Não foi possível obter seller_id através do User Product."
          );
        }
      }

      /*
      =================================================
      6. CATÁLOGO
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

          console.log(
            "RESPOSTA PRODUCTS:",
            {
              status:
                respostaProduto.status,

              id:
                produto?.id,

              nome:
                produto?.name
            }
          );

          if (respostaProduto.ok) {
            let anuncios = [];

            try {
              const respostaAnuncios =
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

              const dadosAnuncios =
                await respostaAnuncios.json();

              console.log(
                "RESPOSTA PRODUCTS ITEMS:",
                {
                  status:
                    respostaAnuncios.status
                }
              );

              if (
                respostaAnuncios.ok
              ) {
                if (
                  Array.isArray(
                    dadosAnuncios
                  )
                ) {
                  anuncios =
                    dadosAnuncios;
                } else if (
                  Array.isArray(
                    dadosAnuncios.results
                  )
                ) {
                  anuncios =
                    dadosAnuncios.results;
                }
              }

            } catch (erroAnuncios) {
              console.error(
                "Erro ao buscar anúncios do catálogo:",
                erroAnuncios.message
              );
            }

            const primeiro =
              anuncios[0] || null;

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

            /*
            Mesmo que não consigamos o item,
            tentamos montar informações do produto.
            */

            const preco =
              Number(
                primeiro?.price || 0
              );

            const precoAnterior =
              Number(
                primeiro?.original_price || 0
              );

            const imagem =
              produto?.pictures?.[0]?.url ||
              produto?.pictures?.[0]?.secure_url ||
              primeiro?.thumbnail ||
              "";

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

            if (
              produto?.name ||
              imagem ||
              preco > 0
            ) {
              return res.json({
                id:
                  idAnuncio ||
                  idCatalogo,

                titulo:
                  produto.name ||
                  produto.title ||
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
              });
            }
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
      7. PROCURAR MLB EM TODO O HTML
      =================================================
      */

      const textoParaAnalise =
        [
          linkOriginal,
          linkFinal,
          htmlResolvido
        ].join("\n");

      const idsEncontrados =
        encontrarTodosIds(
          textoParaAnalise
        );

      console.log(
        "TODOS OS MLBs ENCONTRADOS:",
        idsEncontrados
      );

      const resultadoHTML =
        await tentarMLBs(
          idsEncontrados,
          linkOriginal
        );

      if (resultadoHTML) {
        return res.json(
          resultadoHTML
        );
      }

      /*
      =================================================
      8. ERRO FINAL
      =================================================
      */

      if (
        userProducts.length > 0
      ) {
        return res.status(422).json({
          error:
            "O link contém um User Product do Mercado Livre, mas não foi possível localizar o anúncio MLB correspondente.",

          detalhe:
            "O Mercado Livre identificou o MLBU, porém o acesso ao User Product ou a busca do anúncio associado não retornou um MLB utilizável."
        });
      }

      return res.status(422).json({
        error:
          "Não consegui identificar o produto nesse link.",

        detalhe:
          "Nenhum anúncio MLB utilizável foi encontrado no link."
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
    let conectado =
      false;

    try {
      conectado =
        await garantirToken();
    } catch (erro) {
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
