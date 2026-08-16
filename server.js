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

const headers = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9"
};

async function abrirPagina(url) {
  const resposta = await fetch(url, {
    redirect: "follow",
    headers
  });

  return {
    status: resposta.status,
    url: resposta.url,
    html: await resposta.text()
  };
}

function limpar(texto) {
  return String(texto || "")
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function encontrarId(texto) {
  const valor = String(texto || "");

  // Procura diretamente por IDs de anúncios do Mercado Livre.
  const resultado = valor.match(/\bMLB\d{6,}\b/i);

  if (resultado) {
    return resultado[0].toUpperCase();
  }

  return null;
}

function encontrarMeta(html, nome) {
  const regex = new RegExp(
    `<meta[^>]+(?:property|name)=["']${nome}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );

  const resultado = html.match(regex);

  return resultado ? limpar(resultado[1]) : "";
}

function encontrarTitulo(html) {
  return (
    encontrarMeta(html, "og:title") ||
    encontrarMeta(html, "twitter:title") ||
    ""
  );
}

function encontrarImagem(html) {
  return (
    encontrarMeta(html, "og:image") ||
    encontrarMeta(html, "twitter:image") ||
    ""
  );
}

function encontrarDescricao(html) {
  return (
    encontrarMeta(html, "og:description") ||
    encontrarMeta(html, "description") ||
    ""
  );
}

function encontrarPreco(html) {
  const texto = limpar(html);

  const padroes = [
    /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"amount"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"priceValue"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i
  ];

  for (const padrao of padroes) {
    const resultado = texto.match(padrao);

    if (resultado) {
      const valor = Number(resultado[1]);

      if (valor > 0) {
        return valor;
      }
    }
  }

  return 0;
}

function encontrarPrecoVisivel(html) {
  const texto = limpar(html);

  const resultado = texto.match(
    /R\$\s?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/
  );

  if (!resultado) {
    return 0;
  }

  return Number(
    resultado[1]
      .replace(/\./g, "")
      .replace(",", ".")
  );
}

function encontrarPrecoAnterior(html) {
  const texto = limpar(html);

  const resultados = [
    ...texto.matchAll(
      /R\$\s?([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/g
    )
  ];

  if (resultados.length < 2) {
    return null;
  }

  const valores = resultados
    .map((r) =>
      Number(
        r[1]
          .replace(/\./g, "")
          .replace(",", ".")
      )
    )
    .filter((v) => v > 0);

  if (valores.length < 2) {
    return null;
  }

  return Math.max(...valores);
}

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

app.post("/api/product", async (req, res) => {
  try {
    const link = String(req.body?.url || "").trim();

    if (!link) {
      return res.status(400).json({
        error: "Cole o link do Mercado Livre."
      });
    }

    if (!accessToken) {
      return res.status(401).json({
        error:
          "O Ofertaço ainda não está conectado ao Mercado Livre."
      });
    }

    console.log("Link recebido:", link);

    // Procura o ID do anúncio no próprio link.
    const idProduto = encontrarId(link);

    console.log("Produto identificado:", idProduto);

    if (!idProduto) {
      return res.status(422).json({
        error:
          "Não consegui identificar o ID do produto nesse link."
      });
    }

    // Consulta diretamente a API oficial do Mercado Livre.
    const resposta = await fetch(
      `https://api.mercadolibre.com/items/${idProduto}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      }
    );

    const dados = await resposta.json();

    console.log("RESPOSTA COMPLETA API MERCADO LIVRE:", {
  status: resposta.status,
  dados: dados
});

if (!resposta.ok) {
  return res.status(resposta.status).json({
    error:
      "O Mercado Livre não conseguiu localizar esse produto.",
    detalhe: dados.message || dados.error || "Erro desconhecido"
  });
}

    const preco = Number(dados.price || 0);
    const precoAnterior = Number(dados.original_price || 0);

    const desconto =
      precoAnterior > preco && preco > 0
        ? Math.round((1 - preco / precoAnterior) * 100)
        : 0;

    const imagem =
      dados.pictures?.[0]?.url ||
      dados.thumbnail ||
      "";

    res.json({
      id: dados.id,
      titulo: dados.title || "Produto do Mercado Livre",
      imagem,
      preco,
      precoAnterior:
        precoAnterior > preco ? precoAnterior : null,
      desconto,
      linkAfiliado: link,
      linkFinal:
        dados.permalink || link
    });

  } catch (erro) {
    console.error("ERRO API PRODUTO:", erro);

    res.status(500).json({
      error: "Não foi possível consultar o produto.",
      detalhe: erro.message
    });
  }
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).send(
        "<h2>Erro no OAuth</h2><p>Nenhum código de autorização foi recebido.</p>"
      );
    }

    if (!oauthCodeVerifier) {
      return res.status(400).send(
        "<h2>Erro no OAuth</h2><p>O code_verifier não está disponível.</p>"
      );
    }

    const resposta = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: process.env.MELI_CLIENT_ID,
          client_secret: process.env.MELI_CLIENT_SECRET,
          code: code,
          redirect_uri: MELI_REDIRECT_URI,
          code_verifier: oauthCodeVerifier
        })
      }
    );

    const dados = await resposta.json();
if (resposta.ok && dados.access_token) {
  accessToken = dados.access_token;
}
    console.log("Resposta OAuth:", {
  status: resposta.status,
  dados: dados
});

    if (!resposta.ok || !dados.access_token) {
      return res.status(400).send(`
        <h2>Erro ao obter autorização</h2>
        <p>O Mercado Livre não retornou o token de acesso.</p>
        <p>Status: ${resposta.status}</p>
      `);
    }

    oauthCodeVerifier = null;

    res.send(`
      <h2>Ofertaço conectado com sucesso! 🎉</h2>
      <p>A conta do Mercado Livre foi autorizada.</p>
      <p>O token de acesso foi recebido corretamente.</p>
    `);

  } catch (erro) {
    console.error("Erro OAuth:", erro);

    res.status(500).send(
      "<h2>Erro no OAuth</h2><p>Não foi possível concluir a autorização.</p>"
    );
  }
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Ofertaco iniciado na porta ${PORT}`
  );
});
