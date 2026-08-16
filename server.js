const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const MELI_REDIRECT_URI =
  "https://ofertaco.onrender.com/oauth/callback";

let oauthCodeVerifier = null;
let accessToken = null;

app.use(express.json());
app.use(express.static(__dirname));

/*
=====================================================
FUNÇÕES GERAIS
=====================================================
*/

function gerarCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function gerarCodeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

function encontrarId(texto) {
  const valor = String(texto || "");

  const resultado = valor.match(/\bMLB\d{6,}\b/i);

  if (resultado) {
    return resultado[0].toUpperCase();
  }

  return null;
}

function extrairIdCatalogo(link) {
  const resultado = String(link || "").match(
    /\/p\/(MLB\d{6,})/i
  );

  return resultado
    ? resultado[1].toUpperCase()
    : null;
}

/*
=====================================================
RESOLVE LINK CURTO MELI.LA
=====================================================
*/

async function resolverLink(link) {
  try {
    const resposta = await fetch(link, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "pt-BR,pt;q=0.9"
      }
    });

    const html = await resposta.text();

    console.log("RESOLUÇÃO DO LINK:", {
      original: link,
      status: resposta.status,
      final: resposta.url
    });

    return {
      url: resposta.url,
      html
    };

  } catch (erro) {

    console.error(
      "ERRO AO RESOLVER LINK:",
      erro.message
    );

    return {
      url: link,
      html: ""
    };
  }
}

/*
=====================================================
PROCURA ID DENTRO DA URL E DO HTML
=====================================================
*/

function encontrarProdutoNoLink(url, html) {

  let id = encontrarId(url);

  if (id) {
    return id;
  }

  id = encontrarId(html);

  if (id) {
    return id;
  }

  /*
  Procura também formatos codificados.
  */

  const texto = String(html || "")
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

  id = encontrarId(texto);

  return id || null;
}

/*
=====================================================
OAUTH - AUTORIZAÇÃO DO MERCADO LIVRE
=====================================================
*/

app.get("/oauth/authorize", (req, res) => {

  const verifier =
    gerarCodeVerifier();

  const challenge =
    gerarCodeChallenge(verifier);

  oauthCodeVerifier = verifier;

  const params = new URLSearchParams({
    response_type: "code",
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
});

/*
=====================================================
OAUTH CALLBACK
=====================================================
*/

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

    console.log("Resposta OAuth:", {
      status:
        resposta.status,
      dados
    });

    if (
      !resposta.ok ||
      !dados.access_token
    ) {

      return res.status(400).send(`
        <h2>Erro ao obter autorização</h2>

        <p>
          O Mercado Livre não retornou
          o token de acesso.
        </p>

        <p>
          Status: ${resposta.status}
        </p>

        <pre>${JSON.stringify(
          dados,
          null,
          2
        )}</pre>
      `);
    }

    accessToken =
      dados.access_token;

    oauthCodeVerifier = null;

    console.log(
      "OAuth conectado com sucesso."
    );

    res.send(`
      <h2>Ofertaço conectado com sucesso! 🎉</h2>

      <p>
        A conta do Mercado Livre foi autorizada.
      </p>

      <p>
        O token de acesso foi recebido corretamente.
      </p>
    `);

  } catch (erro) {

    console.error(
      "Erro OAuth:",
      erro
    );

    res.status(500).send(`
      <h2>Erro no OAuth</h2>

      <p>
        Não foi possível concluir a autorização.
      </p>

      <p>
        ${erro.message}
      </p>
    `);
  }
});

/*
=====================================================
API DE PRODUTO
=====================================================
*/

app.post(
  "/api/produto",
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

      if (!accessToken) {

        return res.status(401).json({
          error:
            "O Ofertaço ainda não está conectado ao Mercado Livre."
        });
      }

      console.log(
        "Link recebido:",
        linkOriginal
      );

      /*
      =================================================
      1. RESOLVE O LINK CURTO
      =================================================
      */

      let linkFinal =
        linkOriginal;

      let htmlLink =
        "";

      if (
        linkOriginal.includes("meli.la")
      ) {

        console.log(
          "Link meli.la detectado. Resolvendo..."
        );

        const resolvido =
          await resolverLink(
            linkOriginal
          );

        linkFinal =
          resolvido.url;

        htmlLink =
          resolvido.html;

        console.log(
          "Destino encontrado:",
          linkFinal
        );
      }

      /*
      =================================================
      2. PROCURA PRODUTO DE CATÁLOGO
      =================================================
      */

      let idCatalogo =
        extrairIdCatalogo(
          linkFinal
        );

      /*
      Se não achou na URL, procura
      também no HTML.
      */

      if (!idCatalogo) {

        idCatalogo =
          extrairIdCatalogo(
            htmlLink
          );
      }

      /*
      =================================================
      3. PROCURA ID DE ANÚNCIO
      =================================================
      */

      let idAnuncio =
        encontrarId(
          linkFinal
        );

      if (!idAnuncio) {

        idAnuncio =
          encontrarId(
            htmlLink
          );
      }

      console.log(
        "Product ID de catálogo:",
        idCatalogo
      );

      console.log(
        "ID de anúncio identificado:",
        idAnuncio
      );

      /*
      =================================================
      4. SE FOR CATÁLOGO
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
          JSON.stringify(
            {
              status:
                respostaProduto.status,
              dados:
                produto
            },
            null,
            2
          )
        );

        if (!respostaProduto.ok) {

          return res
            .status(
              respostaProduto.status
            )
            .json({
              error:
                "O Mercado Livre não conseguiu localizar o produto do catálogo.",

              detalhe:
                produto.message ||
                produto.error ||
                "Produto não encontrado."
            });
        }

        /*
        =================================================
        5. BUSCA OS ANÚNCIOS DO CATÁLOGO
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
        6. PRIMEIRO ANÚNCIO
        =================================================
        */

        let anuncio = null;

        if (
          anuncios.length > 0
        ) {

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
          =================================================
          7. CONSULTA ITEM
          =================================================

          Essa consulta pode retornar 403.
          Isso NÃO impede o funcionamento,
          pois podemos obter o preço diretamente
          de products/items.
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

              if (
                respostaItem.ok
              ) {

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
        8. DADOS DO PRODUTO
        =================================================
        */

        const titulo =
          produto.name ||
          produto.title ||
          "Produto do Mercado Livre";

        const imagem =
          produto.pictures?.[0]?.url ||
          produto.thumbnail ||
          "";

        /*
        =================================================
        9. PREÇO
        =================================================
        */

        let preco =
          Number(
            anuncio?.price || 0
          );

        let precoAnterior =
          Number(
            anuncio?.original_price || 0
          );

        /*
        =================================================
        10. SE ITEM NÃO DEU PREÇO,
            USA PRODUCTS/ITEMS
        =================================================
        */

        if (
          preco === 0 &&
          anuncios.length > 0
        ) {

          const primeiro =
            anuncios[0];

          preco =
            Number(
              primeiro.price ||
              primeiro.price_value ||
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
        11. DESCONTO
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

        console.log(
          "DADOS FINAIS DO PRODUTO:",
          {
            id:
              anuncio?.id ||
              idCatalogo,

            titulo,

            preco,

            precoAnterior,

            desconto
          }
        );

        /*
        =================================================
        12. RETORNO
        =================================================
        */

        return res.json({
          id:
            anuncio?.id ||
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
            anuncio?.permalink ||
            linkFinal ||
            linkOriginal
        });
      }

      /*
      =================================================
      13. ANÚNCIO NORMAL
      =================================================
      */

      if (!idAnuncio) {

        return res.status(422).json({
          error:
            "Não consegui identificar o produto nesse link. O link meli.la pode não estar apontando diretamente para um produto."
        });
      }

      console.log(
        "Consultando anúncio:",
        idAnuncio
      );

      const resposta =
        await fetch(
          `https://api.mercadolibre.com/items/${idAnuncio}`,
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
              "Erro"
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
          dados.permalink ||
          linkFinal ||
          linkOriginal
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
SAÚDE
=====================================================
*/

app.get(
  "/saude",
  (req, res) => {

    res.json({
      status:
        "OK",

      ofertaco:
        "online",

      mercadoLivre:
        !!accessToken
    });
  }
);

/*
=====================================================
SERVIDOR
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
);;
