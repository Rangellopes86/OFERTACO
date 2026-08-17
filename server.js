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
UTILITÁRIOS
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
  const valor = String(link || "");

  const resultado = valor.match(
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

async function resolverLink(link) {
  console.log("Resolvendo link:", link);

  let urlAtual = String(link || "").trim();

  if (!urlAtual) {
    throw new Error("Link vazio.");
  }

  let html = "";
  let statusFinal = 0;

  /*
  Seguimos os redirecionamentos manualmente.
  Isso é mais confiável para links meli.la.
  */

  for (let tentativa = 0; tentativa < 10; tentativa++) {

    console.log(
      `Tentativa de redirecionamento ${tentativa + 1}:`,
      urlAtual
    );

    let urlValida;

    try {
      urlValida = new URL(urlAtual);
    } catch (erroURL) {
      console.error(
        "URL inválida durante resolução:",
        urlAtual
      );

      throw new Error(
        `URL inválida: ${urlAtual}`
      );
    }

    const resposta = await fetch(
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

    statusFinal = resposta.status;

    console.log(
      "Status:",
      resposta.status
    );

    /*
    Verifica se o servidor mandou
    para outra URL.
    */

    const location =
      resposta.headers.get("location");

    if (
      resposta.status >= 300 &&
      resposta.status < 400 &&
      location
    ) {

      let proximaURL;

      try {

        proximaURL =
          new URL(
            location,
            urlValida
          ).toString();

      } catch (erroURL) {

        console.error(
          "Erro ao interpretar Location:",
          location
        );

        throw new Error(
          `Redirecionamento inválido recebido pelo Mercado Livre: ${location}`
        );
      }

      console.log(
        "Redirecionando para:",
        proximaURL
      );

      urlAtual = proximaURL;

      continue;
    }

    /*
    Chegamos à página final.
    */

    try {
      html = await resposta.text();
    } catch (erroTexto) {
      console.log(
        "Não foi possível ler HTML:",
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
OAUTH
=====================================================
*/

app.get("/oauth/authorize", (req, res) => {
  try {
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

  } catch (erro) {
    console.error(
      "Erro ao iniciar OAuth:",
      erro
    );

    res.status(500).send(
      "<h2>Erro no OAuth</h2><p>Não foi possível iniciar a autorização.</p>"
    );
  }
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

    console.log(
      "Resposta OAuth:",
      {
        status: resposta.status,
        dados: {
          ...dados,

          access_token:
            dados.access_token
              ? "[RECEBIDO]"
              : undefined,

          refresh_token:
            dados.refresh_token
              ? "[RECEBIDO]"
              : undefined
        }
      }
    );

    if (
      !resposta.ok ||
      !dados.access_token
    ) {

      return res.status(400).send(`
        <h2>Erro ao obter autorização</h2>
        <p>O Mercado Livre não devolveu o token de acesso.</p>
        <p>Status: ${resposta.status}</p>
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

      if (!accessToken) {

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
      1. RESOLVE LINKS CURTOS MELI.LA
      =================================================
      */

      let linkFinal =
        linkOriginal;

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

          if (
            resolvido.urlFinal
          ) {

            linkFinal =
              resolvido.urlFinal;
          }

          console.log(
            "Link após redirecionamento:",
            linkFinal
          );

          /*
          Tenta descobrir o produto
          diretamente na URL final.
          */

          let idEncontrado =
            encontrarId(linkFinal);

          if (!idEncontrado) {

            idEncontrado =
              encontrarId(
                resolvido.html
              );
          }

          if (idEncontrado) {

            console.log(
              "ID encontrado após resolver meli.la:",
              idEncontrado
            );
          }

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
      2. PROCURA ID DE CATÁLOGO
      =================================================
      */

      let idCatalogo =
        extrairIdCatalogo(
          linkFinal
        );

      /*
      Também tenta encontrar MLB
      no HTML caso o redirecionamento
      não deixe o ID diretamente na URL.
      */

      if (!idCatalogo) {

        try {

          const pagina =
            await resolverLink(
              linkFinal
            );

          idCatalogo =
            extrairIdCatalogo(
              pagina.urlFinal
            );

          if (!idCatalogo) {

            idCatalogo =
              encontrarId(
                pagina.urlFinal +
                "\n" +
                pagina.html
              );
          }

        } catch (erroPagina) {

          console.log(
            "Não foi possível analisar a página final:",
            erroPagina.message
          );
        }
      }

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

        if (
          !respostaProduto.ok
        ) {

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
        ===============================================
        4. BUSCA ANÚNCIOS ASSOCIADOS
        ===============================================
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

        } catch (
          erroAnuncios
        ) {

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
        ===============================================
        5. ESCOLHE O PRIMEIRO ANÚNCIO
        ===============================================
        */

        const primeiro =
          anuncios.length > 0
            ? anuncios[0]
            : null;

        if (primeiro) {

          console.log(
            "PRIMEIRO ANÚNCIO ENCONTRADO:",
            JSON.stringify(
              primeiro,
              null,
              2
            )
          );
        }

        const idAnuncio =
          primeiro?.item_id ||
          primeiro?.id ||
          null;

        console.log(
          "ID DO ANÚNCIO:",
          idAnuncio
        );

        /*
        ===============================================
        6. PREÇO
        ===============================================
        */

        let preco =
          Number(
            primeiro?.price || 0
          );

        let precoAnterior =
          Number(
            primeiro?.original_price || 0
          );

        /*
        ===============================================
        7. CONSULTA ANÚNCIO COMPLETO
        ===============================================
        */

        let anuncioCompleto =
          null;

        if (idAnuncio) {

          try {

            const respostaItem =
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

            const dadosItem =
              await respostaItem.json();

            console.log(
              "RESPOSTA ITEM:",
              {
                status:
                  respostaItem.status,

                dados:
                  dadosItem
              }
            );

            if (
              respostaItem.ok
            ) {

              anuncioCompleto =
                dadosItem;

              if (
                Number(
                  dadosItem.price
                ) > 0
              ) {

                preco =
                  Number(
                    dadosItem.price
                  );
              }

              if (
                Number(
                  dadosItem.original_price
                ) > 0
              ) {

                precoAnterior =
                  Number(
                    dadosItem.original_price
                  );
              }
            }

          } catch (
            erroItem
          ) {

            console.log(
              "Não foi possível consultar o anúncio completo:",
              erroItem.message
            );
          }
        }

        /*
        ===============================================
        8. TÍTULO
        ===============================================
        */

        const titulo =
          produto.name ||
          produto.title ||
          "Produto do Mercado Livre";

        /*
        ===============================================
        9. IMAGEM
        ===============================================
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
        ===============================================
        10. DESCONTO
        ===============================================
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

          /*
          Mantém exatamente o link
          enviado pelo usuário.
          */

          linkFinal:
            linkOriginal
        });
      }

      /*
      =================================================
      11. ANÚNCIO NORMAL MLB...
      =================================================
      */

      const idProduto =
        encontrarId(
          linkFinal
        );

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
        {
          status:
            resposta.status,

          dados
        }
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
  "/health",
  (req, res) => {

    res.json({
      status: "OK",

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
