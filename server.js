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

  return resposta.url;
}

function encontrarId(url) {
  const texto = String(url);

  const encontrados = [
    texto.match(/MLB-?(\d{6,})/i),
    texto.match(/\/p\/(MLB\d{6,})/i),
    texto.match(/[?&]item_id=(MLB\d{6,})/i)
  ];

  for (const resultado of encontrados) {
    if (resultado) {
      const numeros = resultado[1].replace(/\D/g, "");
      if (numeros) return "MLB" + numeros;
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

    const linkFinal = await resolverLink(link);

    console.log("Link original:", link);
    console.log("Link final:", linkFinal);

    const idProduto = encontrarId(linkFinal);

    if (!idProduto) {
      return res.status(422).json({
        error: "Não consegui identificar o anúncio nesse link.",
        finalUrl: linkFinal
      });
    }

    const respostaProduto = await fetch(
      `https://api.mercadolibre.com/items/${idProduto}`
    );

    if (!respostaProduto.ok) {
      return res.status(502).json({
        error: "O Mercado Livre não retornou os dados desse produto."
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
      linkFinal
    });

  } catch (erro) {
    console.error("ERRO:", erro);

    res.status(500).json({
      error: "Não foi possível consultar esse link.",
      detalhe: erro.message
    });
  }
});

/*
  Express 5 não aceita app.get("*").
  Usamos uma expressão regular para encaminhar
  as páginas para o index.html.
*/
app.get(/.*/, (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ofertaco iniciado na porta ${PORT}`);
});
