import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

app.get("/", (_, res) => res.send("✅ Gemini Search Proxy is running!"));

app.post("/ask", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing 'query' in body" });

  try {
    // 🔍 1️⃣ TavilyでWeb検索
    const tavilyRes = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({ query, max_results: 3 }),
    });

    const tavily = await tavilyRes.json();
    const context = tavily.results
      ?.map(r => `- ${r.title}\n${r.content}`)
      .join("\n\n") || "（検索結果なし）";

    // 🧠 2️⃣ Geminiで回答生成
    const prompt = `
次の検索結果をもとに、ユーザーの質問に日本語で答えてください。
質問: ${query}

検索結果:
${context}
    `;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      }
    );

    const gemini = await geminiRes.json();
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
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
