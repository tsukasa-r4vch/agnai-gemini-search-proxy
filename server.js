import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-lite";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// サービス稼働確認
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

    // -----------------------------
    // 1️⃣ システムプロンプトを要約
    // -----------------------------
    const systemPrompt = messages.find(m => m.role === "system")?.content || "";
    //const summarizedSystemPrompt = await summarizeSystemPrompt(systemPrompt);

    // -----------------------------
    // 2️⃣ 最後のユーザー質問だけを検索に使用
    // -----------------------------
    const lastUserMessage = messages
      .filter((m) => m.role === "user")
      .slice(-1)[0]?.content;

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
          tavilyData.results?.map((r) => `- ${r.title}\n${r.content}`).join("\n\n") ||
          context;
      } catch (err) {
        console.error("Tavily search error:", err);
      }
    }

    // -----------------------------
    // 4️⃣ Gemini に送るプロンプト
    // -----------------------------
    const chatHistory = messages
      .filter(m => m.role !== "system")
      .map(m => `${m.role}: ${m.content}`).join("\n\n");

    const promptWithContext = `
システムプロンプト:
${systemPrompt}

検索結果:
${context}

会話履歴:
${chatHistory}
`;
    let answer = "（Geminiから回答が得られませんでした）";
    let count = 0;

    while(answer == "（Geminiから回答が得られませんでした）" && count < 5){
      // -----------------------------
      // 5️⃣ Gemini API 呼び出し
      // -----------------------------
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptWithContext }] }],
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" }
            ]
          }),
        }
      );

      const geminiData = await safeJson(geminiRes);

      answer =
        geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "（Geminiから回答が得られませんでした）";
      count++;
    }

    // -----------------------------
    // 6️⃣ OpenAI互換レスポンス返却
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Server running on port ${PORT} (model: ${GEMINI_MODEL})`)
);

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

// -----------------------------
// システムプロンプト要約関数
// -----------------------------
async function summarizeSystemPrompt(systemPrompt) {
  if (!systemPrompt) return "";

  try {
    const summaryRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
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
