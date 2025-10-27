import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// 🔑 環境変数の読み込み
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-lite"; // デフォルトを最新に

// 🔎 動作確認用エンドポイント
app.get("/", (_, res) =>
  res.send(`✅ Gemini Search Proxy is running! (model: ${GEMINI_MODEL})`)
);

// 💬 JSON安全パース
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("⚠️ JSON parse failed:", text.slice(0, 500));
    return {};
  }
}

// 💬 メイン処理
app.post("/ask", async (req, res) => {
    const query = req.body.query 
        // messages配列があれば、最後の要素のcontentを取得
        || req.body.messages?.[req.body.messages.length - 1]?.content 
        || req.body.prompt; // promptキーも念のためサポート
    if (!query)
        return res.status(400).json({ 
            error: "Missing expected input key (query, messages[].content, or prompt) in body",
            received_body_keys: Object.keys(req.body)
        });

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

    const tavily = await safeJson(tavilyRes);
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

    // 🔹 v1 / v1beta 自動切り替え
    const geminiURL = GEMINI_MODEL.startsWith("gemini-2")
      ? `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
      : `https://generativelanguage.googleapis.com/v1/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const geminiRes = await fetch(geminiURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    });

    // 🔹 生レスポンスをログに出す
    const rawText = await geminiRes.text();
    console.log("💡 Gemini raw text response:", rawText);

    // 🔹 JSONパース（安全版）
    const gemini = (() => {
      try {
        return JSON.parse(rawText);
      } catch {
        return {};
      }
    })();

    console.log("Gemini parsed response:", JSON.stringify(gemini, null, 2));

    const answer =
      gemini?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "（Geminiから回答が得られませんでした）";

    res.json({
  id: "chatcmpl-agnai-" + Date.now(),
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: GEMINI_MODEL,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: [{ text: answer }]
      },
      finish_reason: "stop"
    }
  ]
});
    
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Server running on port ${PORT} (model: ${GEMINI_MODEL})`)
);
