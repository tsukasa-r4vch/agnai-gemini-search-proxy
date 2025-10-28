import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// 環境変数
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-lite";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// サービス稼働確認
app.get("/", (_, res) =>
  res.send(`✅ Gemini + OpenRouter Proxy running (default model: ${GEMINI_MODEL})`)
);

// OpenAI互換エンドポイント
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model, messages } = req.body;
    const selectedModel = model || GEMINI_MODEL;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No messages found" });
    }

    // 最後のユーザーメッセージ
    const lastUserMessage = messages.filter(m => m.role === "user").slice(-1)[0]?.content;
    if (!lastUserMessage) return res.status(400).json({ error: "No user text found" });

    // Tavily検索（任意）
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

    // システムプロンプト抽出
    const systemPrompt = messages.find(m => m.role === "system")?.content || "";

    // 履歴生成
    const chatHistory = messages.filter(m => m.role !== "system")
      .map(m => `${m.role}: ${m.content}`).join("\n\n");

    const promptWithContext = `
システムプロンプト:
${systemPrompt}

検索結果:
${context}

会話履歴:
${chatHistory}
`;

    let answer = "（回答なし）";

    // モデルによる振り分け
    if (selectedModel.startsWith("openrouter:")) {
      // OpenRouterの場合
      const modelName = selectedModel.replace(/^openrouter:/, "");
      answer = await callOpenRouter(modelName, messages);
    } else {
      // Geminiの場合
      answer = await callGemini(selectedModel, promptWithContext);
    }

    // OpenAI互換レスポンス返却
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
  console.log(`🌐 Server running on port ${PORT}`)
);

// -----------------------------
// Gemini API呼び出し
// -----------------------------
async function callGemini(model, promptWithContext) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptWithContext }] }],
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        }),
      }
    );
    const data = await safeJson(res);
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "（Geminiから回答が得られませんでした）";
  } catch (err) {
    console.error("Gemini API error:", err);
    return "（Gemini呼び出し中にエラーが発生しました）";
  }
}

// -----------------------------
// OpenRouter API呼び出し
// -----------------------------
async function callOpenRouter(modelName, messages) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: messages
      })
    });
    const data = await safeJson(res);
    return data?.choices?.[0]?.message?.content || "（OpenRouterから回答が得られませんでした）";
  } catch (err) {
    console.error("OpenRouter API error:", err);
    return "（OpenRouter呼び出し中にエラーが発生しました）";
  }
}

// -----------------------------
// 安全なJSON解析
// -----------------------------
async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { 
    console.error("⚠️ Invalid JSON:", text.slice(0, 500));
    return {};
  }
}
