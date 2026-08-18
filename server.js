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
RENOVAR TOKEN
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
CARREGAR TOKEN
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
OAUTH
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
EXTRAIR MLB
=====================================================
*/

function encontrarTodosIds(texto) {
  const valor =
    String(texto || "");

  const encontrados =
    valor.match(/\bMLB\d{6,}\b/gi);

  if (!encontrados) {
    return [];
  }

  return [
    ...new Set(
      encontrados.map(
        id => id.toUpperCase()
      )
    )
  ];
}

/*
=====================================================
EXTRAIR MLBU
=====================================================
*/

function encontrarTodosUserProducts(texto) {
  const valor =
    String(texto || "");

  const encontrados =
    valor.match(/\bMLBU\d{4,}\b/gi);

  if (!encontrados) {
    return [];
  }

  return [
    ...new Set(
      encontrados.map(
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
  let urlAtual =
    String(link || "").trim();

  let html = "";

  for (
    let tentativa = 1;
    tentativa <= 10;
    tentativa++
  ) {
    console.log(
      `Tentativa ${tentativa}:`,
      urlAtual
    );

    const url =
      new URL(urlAtual);

    const resposta =
      await fetch(
        url.toString(),
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
      resposta.headers.get(
        "location"
      );

    if (
      resposta.status >= 300 &&
      resposta.status < 400 &&
      location
    ) {
      urlAtual =
        new URL(
          location,
          url
        ).toString();

      console.log(
        "Redirecionando para:",
        urlAtual
      );

      continue;
    }

    try {
      html =
        await resposta.text();
    } catch {
      html = "";
    }

    return {
      status:
        resposta.status,

      urlFinal:
        url.toString(),

      html
    };
  }

  throw new Error(
    "Muitos redirecionamentos."
  );
}

/*
=====================================================
CONSULTAR ITEM
=====================================================
*/

async function consultarAnuncio(
  idProduto
) {
  console.log(
    "Consultando anúncio:",
    idProduto
  );

  if (!accessToken) {
    return {
      resposta: {
        ok: false,
        status: 401
      },
      dados: {}
    };
  }

  try {
    const resposta =
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

    const dados =
      await resposta.json();

    console.log(
      "RESPOSTA ITEM:",
      {
        status:
          resposta.status,

        id:
          dados?.id,

        titulo:
          dados?.title,

        seller_id:
          dados?.seller_id
      }
    );

    return {
      resposta,
      dados
    };

  } catch (erro) {
    console.error(
      "Erro consultando item:",
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
CONSULTAR USER PRODUCT
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

        user_id:
          dados?.user_id,

        id:
          dados?.id,

        family_id:
          dados?.family_id
      }
    );

    return {
      resposta,
      dados
    };

  } catch (erro) {
    console.error(
      "Erro consultando User Product:",
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
BUSCAR ITENS DO USER PRODUCT
=====================================================
*/

async function buscarAnunciosDoUserProduct(
  idUserProduct,
  sellerId
) {
  if (!sellerId) {
    return [];
  }

  const url =
    `https://api.mercadolibre.com/users/${sellerId}/items/search?user_product_id=${encodeURIComponent(idUserProduct)}`;

  console.log(
    "BUSCA OFICIAL DO MLBU:",
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
      "RESPOSTA BUSCA MLBU:",
      {
        status:
          resposta.status,

        seller_id:
          dados?.seller_id,

        resultados:
          dados?.results
      }
    );

    if (!resposta.ok) {
      return [];
    }

    return Array.isArray(
      dados.results
    )
      ? dados.results
      : [];

  } catch (erro) {
    console.error(
      "Erro na busca do MLBU:",
      erro.message
    );

    return [];
  }
}

/*
=====================================================
MONTAR OFERTA
=====================================================
*/

function montarDadosAnuncio(
  dados,
  linkOriginal
) {
  const preco =
    Number(
      dados?.price || 0
    );

  const precoAnterior =
    Number(
      dados?.original_price || 0
    );

  let desconto = 0;

  if (
    precoAnterior > preco &&
    preco > 0
  ) {
    desconto =
      Math.round(
        (
          1 -
          preco /
            precoAnterior
        ) * 100
      );
  }

  const imagem =
    dados?.pictures?.[0]?.secure_url ||
    dados?.pictures?.[0]?.url ||
    dados?.thumbnail ||
    "";

  return {
    id:
      dados?.id,

    titulo:
      dados?.title ||
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
EXTRAIR PRODUTO DO HTML
=====================================================
*/

function extrairDadosProdutoHTML(
  html,
  linkOriginal
) {
  if (!html) {
    return null;
  }

  const texto =
    String(html);

  console.log(
    "Analisando HTML da página..."
  );

  /*
  Procura informações comuns
  de título.
  */

  const titulos = [
    texto.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    ),

    texto.match(
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i
    ),

    texto.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    )
  ];

  let titulo = "";

  for (const resultado of titulos) {
    if (resultado?.[1]) {
      titulo =
        resultado[1]
          .replace(
            /&amp;/g,
            "&"
          )
          .trim();

      if (titulo) {
        break;
      }
    }
  }

  /*
  Procura imagem principal.
  */

  const imagens = [
    texto.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    ),

    texto.match(
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
    )
  ];

  let imagem = "";

  for (const resultado of imagens) {
    if (resultado?.[1]) {
      imagem =
        resultado[1];

      break;
    }
  }

  /*
  Procura preços em dados
  estruturados/HTML.
  */

  let preco = 0;
  let precoAnterior = 0;

  const precoPatterns = [
    /"price"\s*:\s*"?([\d.,]+)"?/i,
    /"current_price"\s*:\s*"?([\d.,]+)"?/i,
    /"sale_price"\s*:\s*"?([\d.,]+)"?/i
  ];

  for (const regex of precoPatterns) {
    const resultado =
      texto.match(regex);

    if (resultado?.[1]) {
      preco =
        converterNumero(
          resultado[1]
        );

      if (preco > 0) {
        break;
      }
    }
  }

  const precoAnteriorPatterns = [
    /"original_price"\s*:\s*"?([\d.,]+)"?/i,
    /"list_price"\s*:\s*"?([\d.,]+)"?/i
  ];

  for (
    const regex of precoAnteriorPatterns
  ) {
    const resultado =
      texto.match(regex);

    if (resultado?.[1]) {
      precoAnterior =
        converterNumero(
          resultado[1]
        );

      if (
        precoAnterior > 0
      ) {
        break;
      }
    }
  }

  if (
    !titulo &&
    !imagem &&
    !preco
  ) {
    return null;
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

  return {
    id:
      encontrarTodosIds(
        texto
      )[0] || null,

    titulo:
      titulo ||
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
CONVERTER NÚMERO
=====================================================
*/

function converterNumero(valor) {
  let texto =
    String(valor || "")
      .trim();

  if (!texto) {
    return 0;
  }

  /*
  1.234,56
  */

  if (
    texto.includes(",") &&
    texto.includes(".")
  ) {
    texto =
      texto
        .replace(
          /\./g,
          ""
        )
        .replace(
          ",",
          "."
        );
  }

  /*
  1234,56
  */

  else if (
    texto.includes(",")
  ) {
    texto =
      texto.replace(
        ",",
        "."
      );
  }

  texto =
    texto.replace(
      /[^\d.-]/g,
      ""
    );

  const numero =
    Number(texto);

  return Number.isFinite(
    numero
  )
    ? numero
    : 0;
}

/*
=====================================================
OAUTH AUTHORIZE
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
        "Erro OAuth:",
        erro.message
      );

      res.status(500).send(
        "Erro ao iniciar autorização."
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
          .send(
            "Código de autorização não recebido."
          );
      }

      if (!oauthCodeVerifier) {
        return res
          .status(400)
          .send(
            "Code verifier não encontrado."
          );
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
            !!dados.access_token
        }
      );

      if (
        !resposta.ok ||
        !dados.access_token
      ) {
        return res
          .status(400)
          .send(
            `Erro OAuth. Status: ${resposta.status}`
          );
      }

      await salvarTokens(
        dados
      );

      oauthCodeVerifier =
        null;

      res.send(`
        <h2>Ofertaço conectado com sucesso! 🎉</h2>
        <p>Mercado Livre autorizado.</p>
        <p>Token salvo no PostgreSQL.</p>
      `);

    } catch (erro) {
      console.error(
        "Erro OAuth:",
        erro.message
      );

      res.status(500).send(
        "Erro ao concluir OAuth."
      );
    }
  }
);

/*
=====================================================
API PRODUTO
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

      if (
        !(await garantirToken())
      ) {
        return res.status(401).json({
          error:
            "Mercado Livre não conectado."
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
      1. LINK DIRETO MLB
      =================================================
      */

      const idsDiretos =
        encontrarTodosIds(
          linkOriginal
        );

      console.log(
        "MLBs NO LINK ORIGINAL:",
        idsDiretos
      );

      /*
      Se o link já possui um MLB,
      consultamos SOMENTE esse MLB.
      */

      if (
        idsDiretos.length > 0
      ) {
        const idProduto =
          idsDiretos[0];

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

        /*
        Se a API negar o acesso,
        tenta ler a página do produto.
        */

        console.log(
          "API não retornou o item. Tentando página pública do produto..."
        );

        try {
          const pagina =
            await resolverLink(
              linkOriginal
            );

          const dadosHTML =
            extrairDadosProdutoHTML(
              pagina.html,
              linkOriginal
            );

          if (dadosHTML) {
            console.log(
              "Produto encontrado através do HTML."
            );

            return res.json(
              dadosHTML
            );
          }

        } catch (erroPagina) {
          console.log(
            "Não foi possível analisar página:",
            erroPagina.message
          );
        }
      }

      /*
      =================================================
      2. RESOLVER MELI.LA
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

          console.log(
            "LINK FINAL:",
            linkFinal
          );

        } catch (erroLink) {
          console.error(
            "Erro ao resolver meli.la:",
            erroLink.message
          );
        }
      }

      /*
      =================================================
      3. VERIFICAR SE virou PRODUTO DIRETO
      =================================================
      */

      const idsDepoisRedirect =
        encontrarTodosIds(
          linkFinal
        );

      console.log(
        "MLBs APÓS REDIRECIONAMENTO:",
        idsDepoisRedirect
      );

      if (
        idsDepoisRedirect.length > 0
      ) {
        const idProduto =
          idsDepoisRedirect[0];

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

        const dadosHTML =
          extrairDadosProdutoHTML(
            htmlResolvido,
            linkOriginal
          );

        if (dadosHTML) {
          return res.json(
            dadosHTML
          );
        }
      }

      /*
      =================================================
      4. IDENTIFICAR MLBU
      =================================================
      */

      const userProducts =
        encontrarTodosUserProducts(
          [
            linkFinal,
            htmlResolvido
          ].join("\n")
        );

      console.log(
        "MLBUs ENCONTRADOS:",
        userProducts
      );

      /*
      =================================================
      5. TENTAR FLUXO OFICIAL MLBU
      =================================================
      */

      for (
        const idUserProduct of userProducts
      ) {
        const resultadoUP =
          await consultarUserProduct(
            idUserProduct
          );

        /*
        O 403 é tratado como falta
        de permissão. Não fazemos
        centenas de consultas.
        */

        if (
          resultadoUP.resposta.status ===
          403
        ) {
          console.log(
            `MLBU ${idUserProduct}: acesso negado pela API.`
          );

          continue;
        }

        const dadosUP =
          resultadoUP.dados || {};

        const sellerId =
          dadosUP.user_id ||
          dadosUP.seller_id ||
          dadosUP.user?.id ||
          dadosUP.seller?.id ||
          null;

        console.log(
          "SELLER ID DO MLBU:",
          sellerId
        );

        if (!sellerId) {
          continue;
        }

        const anuncios =
          await buscarAnunciosDoUserProduct(
            idUserProduct,
            sellerId
          );

        console.log(
          "MLBs DO MLBU:",
          anuncios
        );

        /*
        Só consulta os MLBs
        oficialmente retornados
        pelo endpoint.
        */

        for (
          const idAnuncio of anuncios
        ) {
          const resultado =
            await consultarAnuncio(
              idAnuncio
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
        }
      }

      /*
      =================================================
      6. TENTAR EXTRAIR DADOS DO HTML
      =================================================
      */

      if (htmlResolvido) {
        const dadosHTML =
          extrairDadosProdutoHTML(
            htmlResolvido,
            linkOriginal
          );

        if (dadosHTML) {
          /*
          Se for página social com vários
          produtos, não vamos escolher
          aleatoriamente um MLB.
          */

          const ehSocial =
            linkFinal.includes(
              "/social/"
            );

          if (!ehSocial) {
            return res.json(
              dadosHTML
            );
          }
        }
      }

      /*
      =================================================
      7. ERRO ESPECÍFICO MLBU
      =================================================
      */

      if (
        userProducts.length > 0
      ) {
        return res.status(422).json({
          error:
            "O link contém um User Product do Mercado Livre, mas a API não permitiu consultar esse produto.",

          detalhe:
            "O Mercado Livre identificou o MLBU, porém o access_token atual recebeu HTTP 403 ao consultar o User Product.",

          userProducts
        });
      }

      /*
      =================================================
      8. ERRO FINAL
      =================================================
      */

      return res.status(422).json({
        error:
          "Não consegui identificar um produto individual nesse link.",

        detalhe:
          "O link parece apontar para uma página do Mercado Livre que contém vários produtos ou não expõe um anúncio individual."
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
    let mercadoLivre =
      false;

    try {
      mercadoLivre =
        await garantirToken();
    } catch {
      mercadoLivre =
        false;
    }

    res.json({
      status:
        "OK",

      ofertaco:
        "online",

      mercadoLivre,

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
