import { createRequire } from 'node:module';
import axios from 'axios';
import process from 'node:process';
import { LRUCache } from 'lru-cache';

const require = createRequire(import.meta.url);

const rateLimitCache = new LRUCache({
  max: 500,
  ttl: 60_000
});

export default async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'Method Not Allowed',
        code: 'INVALID_METHOD'
      });
    }

    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const current = rateLimitCache.get(ip) || 0;
    
    if (current >= 5) {
      return res.status(429).json({
        error: 'Too Many Requests',
        code: 'RATE_LIMITED'
      });
    }
    rateLimitCache.set(ip, current + 1);

    let body;
    try {
      body = await req.json();
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid JSON',
        code: 'INVALID_INPUT'
      });
    }

    if (!body?.ingredients?.trim()) {
      return res.status(400).json({
        error: 'Missing Ingredients',
        code: 'MISSING_INPUT'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error('Missing OpenAI API Key');
      return res.status(500).json({
        error: 'Server Error',
        code: 'CONFIG_ERROR'
      });
    }

    const prompt = `Create diabetic-friendly recipe with: ${body.ingredients}. 
    Requirements:
    - GI < 50
    - GL < 10
    - JSON format with title, ingredients (array), instructions (array), nutrition (carbs, protein, fat, calories, gi, gl)
    - Fun creative name`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const content = response.data.choices[0]?.message?.content;
    if (!content) throw new Error('Empty AI response');

    try {
      const recipe = JSON.parse(content);
      return res.status(200).json(recipe);
    } catch (error) {
      console.error('Invalid JSON:', content);
      return res.status(500).json({
        error: 'Invalid Recipe Format',
        code: 'PARSE_ERROR'
      });
    }

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      error: error.response?.data?.error?.message || 'Processing Error',
      code: 'INTERNAL_ERROR'
    });
  }
};
