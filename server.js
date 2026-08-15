const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const MELI_REDIRECT_URI =
  "https://ofertaco.onrender.com/oauth/callback";

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
  const padroes = [
    /MLB-?(\d{6,})/i,
    /"item_id"\s*:\s*"(MLB\d{6,})"/i,
    /"id"\s*:\s*"(MLB\d{6,})"/i
  ];

  for (const padrao of padroes) {
    const resultado = String(texto).match(padrao);

    if (resultado) {
      const valor = resultado[1];

      if (/^MLB/i.test(valor)) {
        return valor.toUpperCase();
      }

      return "MLB" + valor.replace(/\D/g, "");
    }
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

app.post("/api/product", async (req, res) => {
  try {
    const link = String(req.body?.url || "").trim();

    if (!link) {
      return res.status(400).json({
        error: "Cole o link do Mercado Livre."
      });
    }

    console.log("Link recebido:", link);

    // Primeiro abre o link de afiliado.
    const afiliado = await abrirPagina(link);

    console.log("Destino encontrado:", afiliado.url);

    let html = afiliado.html;
    let urlFinal = afiliado.url;

    // Tenta descobrir o ID do produto.
    const idProduto = encontrarId(
      urlFinal + "\n" + html
    );

    console.log("Produto identificado:", idProduto);

    // Se encontrou o ID, tenta abrir diretamente o anúncio.
    if (idProduto) {
      const paginasProduto = [
        `https://www.mercadolivre.com.br/${idProduto}`,
        `https://produto.mercadolivre.com.br/${idProduto}`
      ];

      for (const urlProduto of paginasProduto) {
        try {
          const paginaProduto = await abrirPagina(urlProduto);

          console.log(
            "Página do produto:",
            paginaProduto.status,
            paginaProduto.url
          );

          if (paginaProduto.html.length > 1000) {
            html = paginaProduto.html;
            urlFinal = paginaProduto.url;
            break;
          }
        } catch (erro) {
          console.log(
            "Falha ao abrir produto:",
            erro.message
          );
        }
      }
    }

    const titulo = encontrarTitulo(html);
    const imagem = encontrarImagem(html);

    let preco = encontrarPreco(html);

    if (!preco) {
      preco = encontrarPrecoVisivel(html);
    }

    let precoAnterior = encontrarPrecoAnterior(html);

    if (
      precoAnterior &&
      precoAnterior <= preco
    ) {
      precoAnterior = null;
    }

    const desconto =
      precoAnterior && preco
        ? Math.round(
            (1 - preco / precoAnterior) * 100
          )
        : 0;

    if (!titulo && !preco && !imagem) {
      return res.status(422).json({
        error:
          "Consegui acessar o link, mas o Mercado Livre não disponibilizou os dados do produto nessa página."
      });
    }

    res.json({
      id: idProduto,
      titulo:
        titulo || "Produto do Mercado Livre",
      imagem,
      preco,
      precoAnterior,
      desconto,
      linkAfiliado: link,
      linkFinal: urlFinal
    });

  } catch (erro) {
    console.error("ERRO:", erro);

    res.status(500).json({
      error:
        "Não foi possível processar o link.",
      detalhe: erro.message
    });
  }
});
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send(
      "<h2>Erro no OAuth</h2><p>Nenhum código de autorização foi recebido.</p>"
    );
  }

  res.send(`
    <h2>Autorização recebida!</h2>
    <p>O Mercado Livre enviou o código corretamente.</p>
    <p>Agora podemos concluir a configuração do Ofertaço.</p>
  `);
});

app.get(/.*/, (req, res) => {
  res.sendFile(
    __dirname + "/index.html"
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Ofertaco iniciado na porta ${PORT}`
  );
});
