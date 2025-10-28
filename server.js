import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const DEFAULT_GEMINI_MODEL = "models/gemini-2.5-flash-lite";

// サービス稼働確認
app.get("/", (_, res) =>
  res.send(`✅ Gemini + OpenRouter + Tavily Proxy running`)
);

// OpenAI互換エンドポイント
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model, messages } = req.body;
    if (!model) return res.status(400).json({ error: "Model is required" });
    if (!messages || !Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: "No messages found" });

    // -----------------------------
    // システムプロンプト要約
    // -----------------------------
    const systemPrompt = messages.find(m => m.role === "system")?.content || "";
    // ここは必要に応じて要約関数を呼べる
    // const summarizedSystemPrompt = await summarizeSystemPrompt(systemPrompt);
    const summarizedSystemPrompt = systemPrompt;

    // -----------------------------
    // 最後のユーザー質問だけを検索に使用
    // -----------------------------
    const lastUserMessage = messages.filter(m => m.role === "user").slice(-1)[0]?.content;
    if (!lastUserMessage) return res.status(400).json({ error: "No user text found" });

    // -----------------------------
    // Tavily検索（任意）
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
          tavilyData.results?.map(r => `- ${r.title}\n${r.content}`).join("\n\n") || context;
      } catch (err) {
        console.error("Tavily search error:", err);
      }
    }

    // -----------------------------
    // プロンプト作成
    // -----------------------------
    const chatHistory = messages
      .filter(m => m.role !== "system")
      .map(m => `${m.role}: ${m.content}`).join("\n\n");

    const promptWithContext = `
システムプロンプト:
${summarizedSystemPrompt}

検索結果:
${context}

会話履歴:
${chatHistory}
`;

    // -----------------------------
    // モデルごとの呼び出し
    // -----------------------------
    let answer = "（応答が得られませんでした）";
    if (model.startsWith("gemini:")) {
      const geminiModel = model.replace("gemini:", "") || DEFAULT_GEMINI_MODEL;
      answer = await callGemini(geminiModel, promptWithContext);
    } else if (model.startsWith("openrouter:")) {
      const orModel = model.replace("openrouter:", "");
      answer = await callOpenRouter(orModel, messages);
    } else {
      return res.status(400).json({ error: "Unknown model prefix" });
    }

    // -----------------------------
    // OpenAI互換レスポンス
    // -----------------------------
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// -----------------------------
// Gemini呼び出し
// -----------------------------
async function callGemini(model, prompt) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
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
    console.error("Gemini call error:", err);
    return "（Gemini呼び出しでエラー発生）";
  }
}

// -----------------------------
// OpenRouter呼び出し
// -----------------------------
async function callOpenRouter(model, messages) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,        // OpenAI互換形式で送信
        stream: false,   // 念のため明示
        max_tokens: 1024 // 必要に応じて調整
      }),
    });
    const data = await safeJson(res);
    return data?.choices?.[0]?.message?.content || "（OpenRouterから回答が得られませんでした）";
  } catch (err) {
    console.error("OpenRouter call error:", err);
    return "（OpenRouter呼び出しでエラー発生）";
  }
}


// -----------------------------
// 安全JSON解析
// -----------------------------
async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } 
  catch { 
    console.error("⚠️ Invalid JSON:", text.slice(0, 500));
    return {};
  }
}

// -----------------------------
// システムプロンプト要約（必要に応じて使用）
// -----------------------------
async function summarizeSystemPrompt(systemPrompt) {
  if (!systemPrompt) return "";
  try {
    const summaryRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${DEFAULT_GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `以下の文章を、長さを7割程度に抑えて要約してください。重要な情報は残してください:\n\n${systemPrompt}`
                }
              ]
            }
          ]
        })
      }
    );
    const data = await safeJson(summaryRes);
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || systemPrompt;
  } catch (err) {
    console.error("System prompt summarization error:", err);
    return systemPrompt;
  }
}
