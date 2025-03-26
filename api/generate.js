import { createRequire } from 'node:module';
import axios from 'axios';
import process from 'node:process';

const require = createRequire(import.meta.url);
const LRUCache = require('lru-cache');

const rateLimitCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60
});

const errorResponse = (res, status, errorData) => {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(errorData));
};

export default async (req, res) => {
  try {
    // Method check
    if (req.method !== 'POST') {
      return errorResponse(res, 405, {
        error: 'Method Not Allowed',
        code: 'INVALID_METHOD',
        message: 'Only POST requests are accepted'
      });
    }

    // Rate limiting
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const requestCount = (rateLimitCache.get(ip) || 0) + 1;
    rateLimitCache.set(ip, requestCount);
    
    if (requestCount > 5) {
      return errorResponse(res, 429, {
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        message: 'Maximum 5 requests per minute allowed'
      });
    }

    // Parse body
    let body;
    try {
      body = await req.json();
    } catch (error) {
      return errorResponse(res, 400, {
        error: 'Invalid Request',
        code: 'INVALID_JSON',
        message: 'Request body must contain valid JSON'
      });
    }

    // Validate input
    if (!body?.ingredients?.trim()) {
      return errorResponse(res, 400, {
        error: 'Invalid Input',
        code: 'MISSING_INGREDIENTS',
        message: 'Please provide at least one ingredient'
      });
    }

    // Verify OpenAI key
    if (!process.env.OPENAI_API_KEY) {
      return errorResponse(res, 500, {
        error: 'Server Error',
        code: 'MISSING_API_KEY',
        message: 'Server configuration error'
      });
    }

    // API call with timeout protection
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 19000);

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: "gpt-3.5-turbo",
          messages: [{
            role: "user",
            content: `Create diabetic-friendly recipe with: ${body.ingredients}. Respond in JSON format with title, ingredients (provided/optional), instructions, nutrition (carbs, protein, fat, calories, gi, gl), and tips.`
          }],
          temperature: 0.5,
          response_format: { type: "json_object" }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      // Validate response structure
      const content = response.data.choices[0]?.message?.content;
      if (!content) throw new Error('Empty AI response');

      try {
        const recipe = JSON.parse(content);
        return res.status(200).json(recipe);
      } catch (error) {
        return errorResponse(res, 500, {
          error: 'Invalid Format',
          code: 'INVALID_RESPONSE',
          message: 'AI returned invalid format',
          content: content
        });
      }

    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }

  } catch (error) {
    const errorData = {
      error: 'Server Error',
      code: 'INTERNAL_ERROR',
      message: error.response?.data?.error?.message || error.message
    };

    if (error.code === 'ECONNABORTED') {
      errorData.message = 'Request timed out - please try simpler ingredients';
    }

    return errorResponse(res, 500, errorData);
  }
};
