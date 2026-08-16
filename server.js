const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const MELI_REDIRECT_URI =
  "https://ofertaco.onrender.com/oauth/callback";

let oauthCodeVerifier = null;
let accessToken = null;

function gerarCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function gerarCodeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

app.use(express.json());
app.use(express.static(__dirname));

function encontrarId(texto) {
  const valor = String(texto || "");

  const resultado = valor.match(/\bMLB\d{6,}\b/i);

  if (resultado) {
    return resultado[0].toUpperCase();
  }

  return null;
}

function extrairProductId(link) {
  const resultado = String(link || "").match(
    /\/p\/(MLB\d{6,})/i
  );

  return resultado
    ? resultado[1].toUpperCase()
    : null;
}

/*
=====================================================
OAUTH - AUTORIZAÇÃO DO MERCADO LIVRE
=====================================================
*/

app.get("/oauth/authorize", (req, res) => {
  const verifier = gerarCodeVerifier();
  const challenge = gerarCodeChallenge(verifier);

  oauthCodeVerifier = verifier;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.MELI_CLIENT_ID,
    redirect_uri: MELI_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  res.redirect(
    "https://auth.mercadolivre.com.br/authorization?" +
      params.toString()
  );
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;

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

    const resposta = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: process.env.MELI_CLIENT_ID,
          client_secret:
            process.env.MELI_CLIENT_SECRET,
          code,
          redirect_uri: MELI_REDIRECT_URI,
          code_verifier: oauthCodeVerifier
        })
      }
    );

    const dados = await resposta.json();

    console.log("Resposta OAuth:", {
      status: resposta.status,
      dados
    });

    if (!resposta.ok || !dados.access_token) {
      return res.status(400).send(`
        <h2>Erro ao obter autorização</h2>
        <p>O Mercado Livre não retornou o token de acesso.</p>
        <p>Status: ${resposta.status}</p>
        <pre>${JSON.stringify(
          dados,
          null,
          2
        )}</pre>
      `);
    }

    accessToken = dados.access_token;
    oauthCodeVerifier = null;

    console.log(
      "OAuth conectado com sucesso."
    );

    res.send(`
      <h2>Ofertaço conectado com sucesso! 🎉</h2>
      <p>A conta do Mercado Livre foi autorizada.</p>
      <p>O token de acesso foi recebido corretamente.</p>
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
});

/*
=====================================================
PRODUTO
=====================================================
*/

app.post("/api/product", async (req, res) => {
  try {
    const link = String(
      req.body?.url || ""
    ).trim();

    if (!link) {
      return res.status(400).json({
        error:
          "Cole o link do Mercado Livre."
      });
    }

    if (!accessToken) {
      return res.status(401).json({
        error:
          "O Ofertaço ainda não está conectado ao Mercado Livre."
      });
    }

    console.log(
      "Link recebido:",
      link
    );

    /*
    ===================================================
    1. VERIFICA SE É UM LINK DE CATÁLOGO /p/MLB...
    ===================================================
    */

    const catalogProductId =
      extrairProductId(link);

    console.log(
      "Product ID de catálogo:",
      catalogProductId
    );

    /*
    ===================================================
    2. CONSULTA O PRODUTO DE CATÁLOGO
    ===================================================
    */

    if (catalogProductId) {

      const respostaProduto =
        await fetch(
          `https://api.mercadolibre.com/products/${catalogProductId}`,
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

      if (!respostaProduto.ok) {
        return res
          .status(respostaProduto.status)
          .json({
            error:
              "O Mercado Livre não conseguiu localizar o produto de catálogo.",
            detalhe:
              produto.message ||
              produto.error ||
              "Produto não encontrado."
          });
      }

      /*
      =================================================
      3. BUSCA OS ANÚNCIOS ASSOCIADOS AO PRODUTO
      =================================================
      */

      let anuncios = [];

      try {

        const respostaAnuncios =
          await fetch(
            `https://api.mercadolibre.com/products/${catalogProductId}/items`,
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

        /*
        ===============================================
        ALTERAÇÃO IMPORTANTE:
        MOSTRA A RESPOSTA COMPLETA NO LOG
        ===============================================
        */

        console.log(
          "RESPOSTA PRODUCTS ITEMS COMPLETA:",
          JSON.stringify(
            {
              status:
                respostaAnuncios.status,
              dados:
                dadosAnuncios
            },
            null,
            2
          )
        );

        if (respostaAnuncios.ok) {

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

        console.log(
          "Erro ao buscar anúncios:",
          erroAnuncios.message
        );
      }

      /*
      =================================================
      4. MOSTRA QUANTOS ANÚNCIOS FORAM ENCONTRADOS
      =================================================
      */

      console.log(
        "Quantidade de anúncios encontrados:",
        anuncios.length
      );

      /*
      =================================================
      5. TENTA PEGAR O PRIMEIRO ANÚNCIO
      =================================================
      */

      let anuncio = null;

      if (anuncios.length > 0) {

        const primeiro =
          anuncios[0];

        console.log(
          "PRIMEIRO ANÚNCIO ENCONTRADO:",
          JSON.stringify(
            primeiro,
            null,
            2
          )
        );

        const anuncioId =
          primeiro.id ||
          primeiro.item_id ||
          primeiro.itemId;

        console.log(
          "ID DO ANÚNCIO:",
          anuncioId
        );

        /*
        ===============================================
        6. TENTA CONSULTAR O ANÚNCIO
        ===============================================
        */

        if (anuncioId) {

          try {

            const respostaItem =
              await fetch(
                `https://api.mercadolibre.com/items/${anuncioId}`,
                {
                  headers: {
                    Authorization:
                      `Bearer ${accessToken}`,
                    Accept:
                      "application/json"
                  }
                }
              );

            const dadosItem =
              await respostaItem.json();

            console.log(
              "RESPOSTA ITEM DO CATÁLOGO:",
              JSON.stringify(
                {
                  status:
                    respostaItem.status,
                  dados:
                    dadosItem
                },
                null,
                2
              )
            );

            if (respostaItem.ok) {
              anuncio =
                dadosItem;
            }

          } catch (erroItem) {

            console.log(
              "Erro ao consultar anúncio:",
              erroItem.message
            );
          }
        }
      }

      /*
      =================================================
      7. DADOS BÁSICOS DO CATÁLOGO
      =================================================
      */

      const titulo =
        produto.name ||
        produto.title ||
        "Produto do Mercado Livre";

      const imagem =
        produto.pictures?.[0]?.url ||
        produto.main_image ||
        produto.thumbnail ||
        "";

      /*
      =================================================
      8. TENTA PEGAR O PREÇO DO ANÚNCIO
      =================================================
      */

      let preco = Number(
        anuncio?.price || 0
      );

      let precoAnterior =
        Number(
          anuncio?.original_price || 0
        );

      /*
      =================================================
      9. SE O ANÚNCIO NÃO TROUXE PREÇO,
         VERIFICA O PRIMEIRO RESULTADO DIRETAMENTE
      =================================================
      */

      if (
        preco === 0 &&
        anuncios.length > 0
      ) {

        const primeiro =
          anuncios[0];

        preco = Number(
          primeiro.price ||
          primeiro.price_amount ||
          primeiro.amount ||
          primeiro.current_price ||
          0
        );

        precoAnterior =
          Number(
            primeiro.original_price ||
            primeiro.originalPrice ||
            primeiro.previous_price ||
            0
          );

        console.log(
          "PREÇO OBTIDO DIRETAMENTE DO RESULTADO:",
          {
            preco,
            precoAnterior
          }
        );
      }

      /*
      =================================================
      10. CALCULA DESCONTO
      =================================================
      */

      const desconto =
        precoAnterior > preco &&
        preco > 0
          ? Math.round(
              (1 -
                preco /
                  precoAnterior) *
                100
            )
          : 0;

      /*
      =================================================
      11. RETORNA OS DADOS PARA O OFERTAÇO
      =================================================
      */

      console.log(
        "DADOS FINAIS DO PRODUTO:",
        {
          id:
            anuncio?.id ||
            catalogProductId,

          titulo,

          preco,

          precoAnterior,

          desconto
        }
      );

      return res.json({
        id:
          anuncio?.id ||
          catalogProductId,

        titulo,

        imagem,

        preco,

        precoAnterior:
          precoAnterior > preco
            ? precoAnterior
            : null,

        desconto,

        linkAfiliado:
          link,

        linkFinal:
          anuncio?.permalink ||
          link
      });
    }

    /*
    =====================================================
    12. CASO NÃO SEJA LINK DE CATÁLOGO,
        TENTA COMO ANÚNCIO NORMAL
    =====================================================
    */

    const idProduto =
      encontrarId(link);

    console.log(
      "ID de anúncio identificado:",
      idProduto
    );

    if (!idProduto) {
      return res.status(422).json({
        error:
          "Não consegui identificar o ID do produto nesse link."
      });
    }

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
      "RESPOSTA COMPLETA API MERCADO LIVRE:",
      JSON.stringify(
        {
          status:
            resposta.status,
          dados
        },
        null,
        2
      )
    );

    if (!resposta.ok) {
      return res.status(
        resposta.status
      ).json({
        error:
          "O Mercado Livre não conseguiu localizar esse anúncio.",
        detalhe:
          dados.message ||
          dados.error ||
          "Erro desconhecido"
      });
    }

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
            (1 -
              preco /
                precoAnterior) *
              100
          )
        : 0;

    const imagem =
      dados.pictures?.[0]?.url ||
      dados.thumbnail ||
      "";

    res.json({
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
        link,

      linkFinal:
        dados.permalink ||
        link
    });

  } catch (erro) {

    console.error(
      "ERRO API PRODUTO:",
      erro
    );

    res.status(500).json({
      error:
        "Não foi possível consultar o produto.",
      detalhe:
        erro.message
    });
  }
});

/*
=====================================================
HEALTH CHECK
=====================================================
*/

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ofertaco: "online",
    mercadoLivre:
      !!accessToken
  });
});

/*
=====================================================
INICIA SERVIDOR
=====================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Ofertaco iniciado na porta ${PORT}`
    );
  }
);
