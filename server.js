import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-lite";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

app.get("/", (_, res) =>
  res.send(`✅ Gemini + Tavily Proxy running on model: ${GEMINI_MODEL}`)
);

// OpenAI互換エンドポイント
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model, messages } = req.body;
    const selectedModel = model || GEMINI_MODEL;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No messages found" });
    }

    // 最後のユーザー発言だけを検索に使用
    const lastUserMessage = messages
      .filter((m) => m.role === "user")
      .slice(-1)[0]?.content;

    if (!lastUserMessage) {
      return res.status(400).json({ error: "No user text found" });
    }

    // 🔎 Tavily検索
    let context = "（検索結果なし）";
    if (TAVILY_API_KEY) {
      try {
        const tavilyRes = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TAVILY_API_KEY}`,
          },
          body: JSON.stringify({ query: lastUserMessage, max_results: 3 }),
        });
        const tavilyData = await safeJson(tavilyRes);
        context =
          tavilyData.results?.map((r) => `- ${r.title}\n${r.content}`).join("\n\n") ||
          context;
      } catch (err) {
        console.error("Tavily search error:", err);
      }
    }

    // Geminiに送信するプロンプト
    const promptWithContext = `
以下はユーザーとの小説的会話です。検索結果も参考にしてください。

検索結果:
${context}

会話履歴:
${messages.map((m) => `${m.role}: ${m.content}`).join("\n\n")}
`;

    // Gemini API 呼び出し
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptWithContext }] }],
        }),
      }
    );

    const geminiData = await safeJson(geminiRes);

    const answer =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "（Geminiから回答が得られませんでした）";

    // OpenAI互換レスポンス
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: selectedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: answer },
          finish_reason: "stop",
        },
      ],
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

// 安全なJSON解析
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("⚠️ Invalid JSON:", text.slice(0, 500));
    return {};
  }
}
