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
INICIALIZAÇÃO DO BANCO
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
SALVAR TOKEN
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
        access_token = EXCLUDED.access_token,

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
CARREGAR TOKEN DO BANCO
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
        "Nenhum token do Mercado Livre encontrado no banco."
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

    /*
    Se o token estiver próximo de expirar,
    tentamos renovar automaticamente.
    */

    if (
      token.expires_at &&
      token.refresh_token
    ) {

      const faltam =
        Number(token.expires_at) -
        Date.now();

      /*
      Renova se faltar menos de
      10 minutos.
      */

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
=====================================================
RENOVAR ACCESS TOKEN
=====================================================
*/

async function renovarAccessToken(
  refreshToken
) {

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

    await salvarTokens(
      dados
    );

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
GARANTIR TOKEN VÁLIDO
=====================================================
*/

async function garantirToken() {

  if (!accessToken) {

    await carregarTokens();
  }

  if (!accessToken) {
    return false;
  }

  return true;
}

/*
=====================================================
EXPRESS
=====================================================
*/

app.use(
  express.json()
);

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

function gerarCodeChallenge(
  verifier
) {

  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

/*
=====================================================
ENCONTRAR ID MLB
=====================================================
*/

function encontrarId(texto) {

  const valor =
    String(texto || "");

  const resultado =
    valor.match(
      /\bMLB\d{6,}\b/i
    );

  if (resultado) {

    return resultado[0]
      .toUpperCase();
  }

  return null;
}

/*
=====================================================
EXTRAIR ID DE CATÁLOGO
SOMENTE DE URL /P/MLB...
=====================================================
*/

function extrairIdCatalogo(
  link
) {

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
ABRIR LINK E SEGUIR REDIRECIONAMENTOS
=====================================================
*/

async function resolverLink(
  link
) {

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
      `Tentativa de redirecionamento ${
        tentativa + 1
      }:`,
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

    } catch (erroTexto) {

      html = "";
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
CONSULTAR ANÚNCIO
=====================================================
*/

async function consultarAnuncio(
  idProduto
) {

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

      dados
    }
  );

  return {
    resposta,
    dados
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
        "<h2>Erro no OAuth</h2><p>Não foi possível iniciar a autorização.</p>"
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

      /*
      Salva no PostgreSQL.
      */

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

      /*
      Garante que temos token.
      */

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
      1. RESOLVE LINK
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
            "Link após redirecionamento:",
            linkFinal
          );

        } catch (erroLink) {

          console.error(
            "Erro ao resolver meli.la:",
            erroLink
          );

          return res.status(400).json({
            error:
              "Não foi possível abrir o link de afiliado do Mercado Livre.",

            detalhe:
              erroLink.message
          });
        }
      }

      /*
      =================================================
      2. IDENTIFICA SE É CATÁLOGO
      =================================================
      
      IMPORTANTE:
      Somente /p/MLB... é tratado como catálogo.
      Um MLB encontrado no HTML de uma página
      social é tratado como anúncio.
      =================================================
      */

      let idCatalogo =
        extrairIdCatalogo(
          linkFinal
        );

      console.log(
        "Product ID de catálogo:",
        idCatalogo
      );

      /*
      =================================================
      3. PRODUTO DE CATÁLOGO
      =================================================
      */

      if (idCatalogo) {

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

        /*
        Se não encontrar como catálogo,
        tentamos como anúncio.
        */

        if (
          !respostaProduto.ok
        ) {

          console.log(
            "Produto não encontrado como catálogo. Tentando como anúncio..."
          );

          const tentativaItem =
            await consultarAnuncio(
              idCatalogo
            );

          if (
            tentativaItem.resposta.ok
          ) {

            return montarRespostaAnuncio(
              tentativaItem.dados,
              linkOriginal
            );
          }

          return res
            .status(
              respostaProduto.status
            )
            .json({
              error:
                "O Mercado Livre não conseguiu localizar esse produto.",

              detalhe:
                produto.message ||
                produto.error ||
                "Produto não encontrado."
            });
        }

        /*
        =================================================
        BUSCA ANÚNCIOS ASSOCIADOS
        =================================================
        */

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
                respostaAnuncios.status,

              dados:
                dadosAnuncios
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
            "Erro ao buscar anúncios:",
            erroAnuncios.message
          );
        }

        console.log(
          "Quantidade de anúncios encontrados:",
          anuncios.length
        );

        /*
        =================================================
        PRIMEIRO ANÚNCIO
        =================================================
        */

        const primeiro =
          anuncios.length > 0
            ? anuncios[0]
            : null;

        const idAnuncio =
          primeiro?.item_id ||
          primeiro?.id ||
          null;

        console.log(
          "ID DO ANÚNCIO:",
          idAnuncio
        );

        let preco =
          Number(
            primeiro?.price || 0
          );

        let precoAnterior =
          Number(
            primeiro?.original_price || 0
          );

        let anuncioCompleto =
          null;

        /*
        =================================================
        CONSULTA ANÚNCIO COMPLETO
        =================================================
        */

        if (idAnuncio) {

          try {

            const resultadoItem =
              await consultarAnuncio(
                idAnuncio
              );

            if (
              resultadoItem.resposta.ok
            ) {

              anuncioCompleto =
                resultadoItem.dados;

              if (
                Number(
                  anuncioCompleto.price
                ) > 0
              ) {

                preco =
                  Number(
                    anuncioCompleto.price
                  );
              }

              if (
                Number(
                  anuncioCompleto.original_price
                ) > 0
              ) {

                precoAnterior =
                  Number(
                    anuncioCompleto.original_price
                  );
              }
            }

          } catch (erroItem) {

            console.log(
              "Erro ao consultar anúncio completo:",
              erroItem.message
            );
          }
        }

        /*
        =================================================
        TÍTULO
        =================================================
        */

        const titulo =
          produto.name ||
          produto.title ||
          anuncioCompleto?.title ||
          "Produto do Mercado Livre";

        /*
        =================================================
        IMAGEM
        =================================================
        */

        let imagem = "";

        if (
          Array.isArray(
            produto.pictures
          ) &&
          produto.pictures.length > 0
        ) {

          imagem =
            produto.pictures[0].url ||
            produto.pictures[0].secure_url ||
            "";
        }

        if (
          !imagem &&
          anuncioCompleto
        ) {

          imagem =
            anuncioCompleto
              .pictures?.[0]?.url ||
            anuncioCompleto.thumbnail ||
            "";
        }

        /*
        =================================================
        DESCONTO
        =================================================
        */

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

        console.log(
          "DADOS FINAIS DO PRODUTO:",
          {
            id:
              idAnuncio ||
              idCatalogo,

            titulo,

            preco,

            precoAnterior,

            desconto
          }
        );

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

      /*
      =================================================
      4. ANÚNCIO NORMAL MLB...
      =================================================
      */

      let idProduto =
        encontrarId(
          linkFinal
        );

      /*
      Se não encontrou na URL final,
      procura no HTML do meli.la.
      */

      if (!idProduto) {

        idProduto =
          encontrarId(
            htmlResolvido
          );
      }

      /*
      Se ainda não encontrou, tenta
      consultar a página novamente.
      */

      if (!idProduto) {

        try {

          const pagina =
            await resolverLink(
              linkFinal
            );

          idProduto =
            encontrarId(
              pagina.urlFinal +
              "\n" +
              pagina.html
            );

        } catch (erroPagina) {

          console.log(
            "Não foi possível analisar a página final:",
            erroPagina.message
          );
        }
      }

      console.log(
        "ID DO ANÚNCIO IDENTIFICADO:",
        idProduto
      );

      if (!idProduto) {

        return res.status(422).json({
          error:
            "Não consegui identificar o produto nesse link."
        });
      }

      /*
      =================================================
      CONSULTA ANÚNCIO
      =================================================
      */

      const resultado =
        await consultarAnuncio(
          idProduto
        );

      const resposta =
        resultado.resposta;

      const dados =
        resultado.dados;

      if (!resposta.ok) {

        return res
          .status(
            resposta.status
          )
          .json({
            error:
              "O Mercado Livre não conseguiu localizar esse anúncio.",

            detalhe:
              dados.message ||
              dados.error ||
              "Erro desconhecido"
          });
      }

      return montarRespostaAnuncio(
        dados,
        linkOriginal
      );

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
MONTAR RESPOSTA DE ANÚNCIO
=====================================================
*/

function montarRespostaAnuncio(
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
    json: true,
    data: {
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
    }
  };
}

/*
=====================================================
CORRIGIR RETORNO DA FUNÇÃO DE ANÚNCIO
=====================================================
*/

function enviarRespostaAnuncio(
  res,
  resultado
) {

  if (
    resultado &&
    resultado.json &&
    resultado.data
  ) {

    return res.json(
      resultado.data
    );
  }

  return res.status(500).json({
    error:
      "Erro ao montar resposta do anúncio."
  });
}

/*
=====================================================
AJUSTE PARA AS CHAMADAS DE ANÚNCIO
=====================================================
*/

/*
Substitui a função acima por uma versão
que retorna diretamente o objeto Express.
*/

function respostaAnuncio(
  res,
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

  return res.json({

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
  });
}

/*
=====================================================
SAÚDE
=====================================================
*/

app.get(
  "/health",
  async (req, res) => {

    let conectado = false;

    try {

      conectado =
        await garantirToken();

    } catch (erro) {

      conectado = false;
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

iniciarServidor();;
