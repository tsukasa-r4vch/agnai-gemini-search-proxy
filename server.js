import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// 🔑 環境変数
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-lite";

// 🔎 動作確認
app.get("/", (_, res) =>
  res.send(`✅ Gemini Search Proxy is running!`)
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
  // OpenAI形式のリクエストから質問文を抽出
  const model = req.body.model || DEFAULT_MODEL;
  const messages = req.body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "Missing messages in body" });

  // 最新のユーザーメッセージを取得
  const userMsg = messages.reverse().find(m => m.role === "user");
  const query = userMsg?.content?.[0]?.text;
  if (!query) return res.status(400).json({ error: "No user text found" });

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

    // 🔹 v1/v1beta 自動切替
    const geminiURL = model.startsWith("gemini-2")
      ? `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${GEMINI_API_KEY}`
      : `https://generativelanguage.googleapis.com/v1/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const geminiRes = await fetch(geminiURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    });

    const rawText = await geminiRes.text();
    console.log("💡 Gemini raw text response:", rawText);

    const gemini = (() => {
      try {
        return JSON.parse(rawText);
      } catch {
        return {};
      }
    })();

    const answer =
      gemini?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "（Geminiから回答が得られませんでした）";

    // 🔹 OpenAI Chat API 互換形式で返す
    res.json({
      id: "chatcmpl-agnai-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [{ text: answer }],
          },
          finish_reason: "stop",
        },
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Render 用ポート
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Server running on port ${PORT}`)
);
