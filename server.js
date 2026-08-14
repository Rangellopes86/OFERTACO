const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

async function resolverLink(url) {
  const resposta = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0"
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
    /\/p\/(MLB\d{6,})/i,
    /\/MLB-?(\d{6,})/i
  ];

  for (const padrao of padroes) {
    const resultado = texto.match(padrao);

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

app.post("/api/product", async (req, res) => {
  try {
    const link = String(req.body?.url || "").trim();

    if (!link) {
      return res.status(400).json({
        error: "Cole o link do Mercado Livre."
      });
    }

    if (!/^https?:\/\//i.test(link)) {
      return res.status(400).json({
        error: "O link precisa começar com https://"
      });
    }

    console.log("Link recebido:", link);

    const destino = await resolverLink(link);

    console.log("Destino encontrado:", destino.urlFinal);

    // Procura o ID tanto na URL final quanto no conteúdo retornado.
    const idProduto =
      encontrarId(destino.urlFinal) ||
      encontrarId(destino.html);

    if (!idProduto) {
      return res.status(422).json({
        error: "Não consegui identificar o anúncio nesse link.",
        finalUrl: destino.urlFinal
      });
    }

    console.log("Produto identificado:", idProduto);

    const respostaProduto = await fetch(
      `https://api.mercadolibre.com/items/${idProduto}`
    );

    if (!respostaProduto.ok) {
      return res.status(502).json({
        error: "O Mercado Livre não retornou os dados do produto.",
        status: respostaProduto.status
      });
    }

    const produto = await respostaProduto.json();

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
      titulo: produto.title,
      preco,
      precoAnterior,
      desconto,
      imagem,
      linkAfiliado: link,
      linkFinal: destino.urlFinal
    });

  } catch (erro) {
    console.error("ERRO:", erro);

    res.status(500).json({
      error: "Não foi possível consultar esse link.",
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
