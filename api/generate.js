import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const LRUCache = require('lru-cache');
import axios from 'axios';

const rateLimitCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 // 1-minute rate limiting
});

export default async (req, res) => {
  // Rate limiting and method check
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (rateLimitCache.get(ip) >= 5) return res.status(429).json({ error: 'Too many requests' });
  rateLimitCache.set(ip, (rateLimitCache.get(ip) || 0) + 1);

  try {
    const { ingredients } = await req.json();
    
    // AI Prompt Structure
    const prompt = `As a diabetes nutritionist, create a recipe with: ${ingredients}. Rules:
    1. Title: Fun creative name using food puns
    2. Diabetic-friendly (GI < 50, GL < 10)
    3. Format response as JSON:
    {
      "title": "Recipe Name",
      "ingredients": {
        "provided": ["1 cup broccoli (GI=15)"], 
        "optional": ["1 tbsp olive oil"]
      },
      "instructions": ["Step 1..."],
      "nutrition": {
        "carbs": "8g",
        "fiber": "5g",
        "gl": 3,
        "calories": 250,
        "protein": "20g",
        "fat": "10g"
      },
      "tips": "Pair with [whole-grain bread](https://amzn.to/3...) for better GI"
    }`;

    const aiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const recipe = JSON.parse(aiResponse.data.choices[0].message.content);
    res.status(200).json(recipe);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: error.response?.data?.error?.message || 'Recipe generation failed',
      details: error.message
    });
  }
};