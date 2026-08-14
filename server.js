const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

async function buscarPagina(url) {
  const resposta = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9"
    }
  });

  return {
    urlFinal: resposta.url,
    html: await resposta.text()
  };
}

function encontrarId(texto) {
  const padroes = [
    /MLB-?(\d{6,})/i,
    /"id"\s*:\s*"(MLB\d{6,})"/i,
    /"item_id"\s*:\s*"(MLB\d{6,})"/i,
    /\/p\/(MLB\d{6,})/i
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

async function buscarProduto(id) {
  const urls = [
    `https://api.mercadolibre.com/items/${id}`,
    `https://api.mercadolibre.com/items/${id}?include_attributes=all`
  ];

  for (const url of urls) {
    try {
      const resposta = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      });

      console.log("API Mercado Livre:", resposta.status);

      if (resposta.ok) {
        return await resposta.json();
      }
    } catch (erro) {
      console.log("Falha na API:", erro.message);
    }
  }

  return null;
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

    const pagina = await buscarPagina(link);

    console.log("Destino encontrado:", pagina.urlFinal);

    const idProduto =
      encontrarId(pagina.urlFinal) ||
      encontrarId(pagina.html);

    if (!idProduto) {
      return res.status(422).json({
        error: "Não consegui identificar o anúncio nesse link."
      });
    }

    console.log("Produto identificado:", idProduto);

    const produto = await buscarProduto(idProduto);

    if (!produto) {
      return res.status(502).json({
        error:
          "O Mercado Livre não permitiu consultar os dados desse anúncio."
      });
    }

    const preco = Number(produto.price || 0);

    const precoAnterior =
      produto.original_price &&
      Number(produto.original_price) > preco
        ? Number(produto.original_price)
        : null;

    const desconto = precoAnterior
      ? Math.round((1 - preco / precoAnterior) * 100)
      : 0;

    const imagem =
      produto.pictures?.[0]?.secure_url ||
      produto.pictures?.[0]?.url ||
      produto.thumbnail ||
      "";

    res.json({
      id: produto.id,
      titulo: produto.title || "Produto Mercado Livre",
      preco,
      precoAnterior,
      desconto,
      imagem,
      linkAfiliado: link,
      linkFinal: pagina.urlFinal
    });

  } catch (erro) {
    console.error("ERRO:", erro);

    res.status(500).json({
      error: "Erro ao processar o link.",
      detalhe: erro.message
    });
  }
});

app.get(/.*/, (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ofertaco iniciado na porta ${PORT}`);
});
