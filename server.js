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
        ? Date.now() +
          Number(dados.expires_in) * 1000
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

    accessToken =
      dados.access_token;

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
RENOVAR TOKEN
=====================================================
*/

async function renovarAccessToken(refreshToken) {

  try {

    console.log(
      "Solicitando renovação do access_token..."
    );

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
                "refresh_token",

              client_id:
                process.env.MELI_CLIENT_ID,

              client_secret:
                process.env.MELI_CLIENT_SECRET,

              refresh_token:
                refreshToken
            })
        }
      );

    const dados =
      await resposta.json();

    console.log(
      "Resposta renovação OAuth:",
      {
        status:
          resposta.status,

        sucesso:
          !!dados.access_token
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

    const resultado =
      await pool.query(`
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
        "Nenhum token do Mercado Livre encontrado."
      );

      return false;
    }

    const token =
      resultado.rows[0];

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
      "Erro ao carregar token:",
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
        id =>
          id.toUpperCase()
      )
    )
  ];
}

/*
=====================================================
EXTRAIR CATÁLOGO /P/MLB...
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
EXTRAIR POSSÍVEIS IDs DE LINKS HTML
=====================================================
*/

function extrairIdsDeLinks(html) {

  const valor =
    String(html || "");

  const ids = [];

  const padroes = [

    /\/(MLB\d{6,})(?:[/?#]|$)/gi,

    /item[_-]?id["':=\s]+["']?(MLB\d{6,})/gi,

    /product[_-]?id["':=\s]+["']?(MLB\d{6,})/gi,

    /"id"\s*:\s*"?(MLB\d{6,})/gi,

    /"item_id"\s*:\s*"?(MLB\d{6,})/gi
  ];

  for (
    const padrao of padroes
  ) {

    let resultado;

    while (
      (resultado =
        padrao.exec(valor)) !== null
    ) {

      ids.push(
        resultado[1].toUpperCase()
      );
    }
  }

  return [
    ...new Set(ids)
  ];
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

    const urlValida =
      new URL(urlAtual);

    const resposta =
      await fetch(
        urlValida.toString(),
        {
          method: "GET",

          redirect: "manual",

          headers: {

            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",

            "Accept":
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

    } catch (erro) {

      html = "";

      console.log(
        "Erro ao ler HTML:",
        erro.message
      );
    }

    console.log(
      "URL final:",
      urlValida.toString()
    );

    return {

      status:
        statusFinal,

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
CONSULTAR ITEM
=====================================================

Faz duas tentativas:

1. Com access token
2. Sem access token

Também retorna informações detalhadas
sobre o erro para podermos descobrir
exatamente o que o Mercado Livre está recusando.
=====================================================
*/

async function consultarAnuncio(idProduto) {

  console.log(
    "=============================================="
  );

  console.log(
    "CONSULTANDO ITEM:",
    idProduto
  );

  /*
  =================================================
  TENTATIVA 1 - COM TOKEN
  =================================================
  */

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

  let texto =
    await resposta.text();

  let dados = {};

  try {

    dados =
      JSON.parse(texto);

  } catch {

    dados = {
      resposta_texto:
        texto
    };
  }

  console.log(
    "ITEM COM TOKEN:",
    {
      status:
        resposta.status,

      dados
    }
  );

  /*
  =================================================
  TENTATIVA 2 - SEM TOKEN
  =================================================
  */

  if (
    resposta.status === 401 ||
    resposta.status === 403
  ) {

    console.log(
      "Token recusado. Tentando consulta pública..."
    );

    const respostaPublica =
      await fetch(
        `https://api.mercadolibre.com/items/${idProduto}`,
        {
          headers: {
            Accept:
              "application/json"
          }
        }
      );

    const textoPublico =
      await respostaPublica.text();

    let dadosPublicos = {};

    try {

      dadosPublicos =
        JSON.parse(textoPublico);

    } catch {

      dadosPublicos = {
        resposta_texto:
          textoPublico
      };
    }

    console.log(
      "ITEM SEM TOKEN:",
      {
        status:
          respostaPublica.status,

        dados:
          dadosPublicos
      }
    );

    return {

      resposta:
        respostaPublica,

      dados:
        dadosPublicos,

      autenticada:
        false
    };
  }

  return {

    resposta,

    dados,

    autenticada:
      true
  };
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
        erro
      );

      res.status(500).send(
        "<h2>Erro no OAuth</h2>"
      );
    }
  }
);

/*
=====================================================
OAUTH - CALLBACK
=====================================================
*/

app.get(
  "/oauth/callback",
  async (req, res) => {

    try {

      const code =
        req.query.code;

      if (!code) {

        return res.status(400).send(`
          <h2>Erro no OAuth</h2>
          <p>Nenhum código de autorização foi recebido.</p>
        `);
      }

      if (!oauthCodeVerifier) {

        return res.status(400).send(`
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

        return res.status(400).send(`
          <h2>Erro ao obter autorização</h2>
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
      RESOLVER LINK
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
          "Link curto detectado. Resolvendo..."
        );

        const resolvido =
          await resolverLink(
            linkOriginal
          );

        linkFinal =
          resolvido.urlFinal;

        htmlResolvido =
          resolvido.html;

        console.log(
          "LINK FINAL:",
          linkFinal
        );
      }

      /*
      =================================================
      EXTRAIR IDs
      =================================================
      */

      let idsEncontrados = [];

      /*
      Primeiro procura no URL.
      */

      idsEncontrados.push(
        ...encontrarTodosIds(
          linkFinal
        )
      );

      /*
      Depois procura nos links HTML.
      */

      idsEncontrados.push(
        ...extrairIdsDeLinks(
          htmlResolvido
        )
      );

      /*
      Depois procura de forma geral
      no HTML.
      */

      idsEncontrados.push(
        ...encontrarTodosIds(
          htmlResolvido
        )
      );

      idsEncontrados =
        [
          ...new Set(
            idsEncontrados
          )
        ];

      console.log(
        "TODOS OS IDs ENCONTRADOS:",
        idsEncontrados
      );

      /*
      =================================================
      CATÁLOGO
      =================================================
      */

      const idCatalogo =
        extrairIdCatalogo(
          linkFinal
        );

      if (idCatalogo) {

        console.log(
          "ID DE CATÁLOGO ENCONTRADO:",
          idCatalogo
        );

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

              dados:
                produto
            }
          );

          if (
            respostaProduto.ok
          ) {

            return res.json({

              id:
                idCatalogo,

              titulo:
                produto.name ||
                produto.title ||
                "Produto do Mercado Livre",

              imagem:
                produto.pictures?.[0]?.url ||
                produto.pictures?.[0]?.secure_url ||
                "",

              preco:
                0,

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

          console.log(
            "Erro consultando catálogo:",
            erroCatalogo.message
          );
        }
      }

      /*
      =================================================
      NÃO ENCONTROU ID
      =================================================
      */

      if (
        idsEncontrados.length === 0
      ) {

        console.log(
          "Nenhum ID MLB encontrado."
        );

        return res.status(422).json({

          error:
            "Não consegui identificar o produto nesse link.",

          linkFinal:
            linkFinal
        });
      }

      /*
      =================================================
      TESTAR CADA ID
      =================================================
      */

      let ultimoErro =
        null;

      for (
        const idProduto of idsEncontrados
      ) {

        console.log(
          "--------------------------------------------"
        );

        console.log(
          "TESTANDO ID:",
          idProduto
        );

        try {

          const resultado =
            await consultarAnuncio(
              idProduto
            );

          if (
            resultado.resposta.ok
          ) {

            console.log(
              "============================================"
            );

            console.log(
              "ANÚNCIO ENCONTRADO COM SUCESSO:",
              idProduto
            );

            return res.json(
              montarDadosAnuncio(
                resultado.dados,
                linkOriginal
              )
            );
          }

          ultimoErro = {

            id:
              idProduto,

            status:
              resultado.resposta.status,

            dados:
              resultado.dados
          };

          console.log(
            "ID NÃO ACEITO:",
            ultimoErro
          );

        } catch (erroItem) {

          ultimoErro = {

            id:
              idProduto,

            erro:
              erroItem.message
          };

          console.log(
            "ERRO:",
            ultimoErro
          );
        }
      }

      /*
      =================================================
      NENHUM ANÚNCIO FUNCIONOU
      =================================================
      */

      console.log(
        "============================================"
      );

      console.log(
        "NENHUM ID PÔDE SER CONSULTADO."
      );

      console.log(
        "ÚLTIMO ERRO:",
        ultimoErro
      );

      return res.status(403).json({

        error:
          "O Mercado Livre não permitiu consultar o anúncio encontrado.",

        idsEncontrados,

        ultimoErro,

        linkFinal
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
=====================================================
INICIAR
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
        `Ofertaco iniciado na porta ${PORT}`
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
