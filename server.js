import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash-lite";

// ✅ 動作確認
app.get("/", (_, res) => res.send(`✅ Gemini Proxy OK (model: ${GEMINI_MODEL})`));

// 💬 OpenAI形式の /v1/chat/completions
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: "Invalid messages format" });

    // 🧠 userメッセージを抽出
    const userMsg = messages.find(m => m.role === "user")?.content;
    if (!userMsg) return res.status(400).json({ error: "No user text found" });

    // Geminiに送信
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: userMsg }] }],
        }),
      }
    );

    const text = await geminiRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Gemini raw text:", text);
      return res.status(500).json({ error: "Invalid Gemini response" });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "（Geminiから回答が得られませんでした）";

    res.json({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: GEMINI_MODEL,
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
  console.log(`🌐 Running on port ${PORT} (model: ${GEMINI_MODEL})`)
);
