import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

app.get("/", (_, res) => res.send("✅ Gemini Proxy + OpenRouter Switch Ready"));

// ---------------------------
// 共通補助関数
// ---------------------------
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("⚠️ Invalid JSON:", text.slice(0, 500));
    return {};
  }
}

// ---------------------------
// OpenAI互換API
// ---------------------------
app.post("/v1/chat/completions", async (req, res) => {
  const { model = "gemini-pro", messages } = req.body;

  try {
    let answer = "";

    // ====== OpenRouterモデル指定時 ======
    if (model.startsWith("openrouter:")) {
      const routerModel = model.replace("openrouter:", "");
      console.log(`🔁 Routing to OpenRouter model: ${routerModel}`);

      const routerRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://your-app.onrender.com",
          "X-Title": "Gemini Proxy",
        },
        body: JSON.stringify({
          model: routerModel,
          messages,
        }),
      });

      const routerData = await safeJson(routerRes);
      answer =
        routerData?.choices?.[0]?.message?.content ||
        "（OpenRouterから回答が得られませんでした）";
    }

    // ====== Geminiモデル指定時 ======
    else if (model.startsWith("gemini")) {
      console.log(`🔁 Routing to Gemini model: ${model}`);

      // Gemini用のフォーマット
      const userText = messages
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: userText }] }],
          }),
        }
      );

      const geminiData = await safeJson(geminiRes);
      answer =
        geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "（Geminiから回答が得られませんでした）";
    }

    // ====== 不明モデル時 ======
    else {
      answer = `（対応していないモデル指定です: ${model}）`;
    }

    // ---------------------------
    // OpenAI互換形式で返す
    // ---------------------------
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
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
  console.log(`🌐 Proxy server running on port ${PORT}`)
);
