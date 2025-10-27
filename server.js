import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// 🔑 環境変数の読み込み
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest"; // デフォルト設定

// 🔎 動作確認用エンドポイント
app.get("/", (_, res) =>
  res.send(`✅ Gemini Search Proxy is running! (model: ${GEMINI_MODEL})`)
);

// 💬 メイン処理
app.post("/ask", async (req, res) => {
  const { query } = req.body;
  if (!query)
    return res.status(400).json({ error: "Missing 'query' in body" });

  try {
    // 1️⃣ Tavily で検索
    const tavilyRes = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({ query, max_results: 3 }),
    });

    const tavily = await tavilyRes.json();
    const context =
      tavily.results?.map(r => `- ${r.title}\n${r.content}`).join("\n\n") ||
      "（検索結果なし）";

    // 2️⃣ Gemini に質問
    const prompt = `
次の検索結果をもとに、ユーザーの質問に日本語で答えてください。
質問: ${query}

検索結果:
${context}
    `;
    
const geminiURL = GEMINI_MODEL.startsWith("gemini-2")
  ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  : `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const geminiRes = await fetch(geminiURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    });

    const gemini = await safeJson(geminiRes);

    console.log("Gemini raw response:", gemini);
    console.log("Gemini raw response:", JSON.stringify(gemini, null, 2));

    const answer =
      gemini?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "（Geminiから回答が得られませんでした）";

    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Server running on port ${PORT} (model: ${GEMINI_MODEL})`)
);

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("⚠️ JSON parse failed:", text.slice(0, 500)); // 先頭500文字を出力
    return {}; // 空オブジェクトを返して処理を継続
  }
}
