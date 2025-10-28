import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-lite";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// -----------------------------
// サービス稼働確認
// -----------------------------
app.get("/", (_, res) =>
  res.send(`✅ Gemini + OpenRouter + Tavily Proxy running`)
);

// -----------------------------
// OpenAI互換エンドポイント
// -----------------------------
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model, messages } = req.body;
    const selectedModel = model || GEMINI_MODEL;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No messages found" });
    }

    // -----------------------------
    // 1️⃣ システムプロンプト取得
    // -----------------------------
    const systemPrompt = messages.find(m => m.role === "system")?.content || "";

    // -----------------------------
    // 2️⃣ 最後のユーザー質問だけを検索に使用
    // -----------------------------
    const lastUserMessage = messages.filter(m => m.role === "user").slice(-1)[0]?.content;
    if (!lastUserMessage) {
      return res.status(400).json({ error: "No user text found" });
    }

    // -----------------------------
    // 3️⃣ Tavily検索（任意）
    // -----------------------------
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
          tavilyData.results?.map(r => `- ${r.title}\n${r.content}`).join("\n\n") ||
          context;
      } catch (err) {
        console.error("Tavily search error:", err);
      }
    }

    // -----------------------------
    // 4️⃣ 会話履歴作成
    // -----------------------------
    const chatHistory = messages
      .filter(m => m.role !== "system")
      .map(m => `${m.role}: ${m.content}`)
      .join("\n\n");

    const promptWithContext = `
システムプロンプト:
${systemPrompt}

検索結果:
${context}

会話履歴:
${chatHistory}
`;

    // -----------------------------
    // 5️⃣ API種別判定・リクエスト準備
    // -----------------------------
    let apiUrl, apiKeyHeader, body;
    if (selectedModel.startsWith("openrouter:")) {
      // OpenRouter
      const modelName = selectedModel.replace("openrouter:", "");
      apiUrl = `https://openrouter.ai/api/v1/chat/completions`;
      apiKeyHeader = { Authorization: `Bearer ${OPENROUTER_API_KEY}` };
      body = {
        model: modelName,
        messages: [{ role: "user", content: promptWithContext }],
      };
    } else {
      // Gemini
      apiUrl = `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`;
      apiKeyHeader = {};
      body = {
        contents: [{ role: "user", parts: [{ text: promptWithContext }] }],
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      };
    }

    // -----------------------------
    // 6️⃣ リトライ処理（429対応）
    // -----------------------------
    let answer = "（回答が得られませんでした）";
    const maxRetries = 5;
    let attempt = 0;

    while (attempt < maxRetries) {
      const apiRes = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiKeyHeader },
        body: JSON.stringify(body),
      });

      const data = await safeJson(apiRes);

      // レスポンス取得
      if (selectedModel.startsWith("openrouter:")) {
        answer = data?.choices?.[0]?.message?.content || answer;
      } else {
        answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || answer;
      }

      if (answer !== "（回答が得られませんでした）") break;

      // 429ならリトライ
      if (apiRes.status === 429) {
        console.warn(`⚠️ Rate limited, retrying in 3s... (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, 3000));
        attempt++;
      } else {
        break;
      }
    }

    // -----------------------------
    // 7️⃣ OpenAI互換レスポンス返却
    // -----------------------------
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

// -----------------------------
// 安全なJSON解析
// -----------------------------
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("⚠️ Invalid JSON:", text.slice(0, 500));
    return {};
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Server running on port ${PORT}`)
);
