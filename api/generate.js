import { createRequire } from 'node:module';
import axios from 'axios';
import process from 'node:process';

const require = createRequire(import.meta.url);
const LRUCache = require('lru-cache');

// Initialize rate limiter
const rateLimitCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 // 1 minute
});

// Enhanced error logger
const logError = (error, context = {}) => {
  console.error('\x1b[31m', `[ERROR] ${new Date().toISOString()}`, {
    message: error.message,
    stack: error.stack,
    ...context
  }, '\x1b[0m');
};

export default async (req, res) => {
  try {
    // Validate request method
    if (req.method !== 'POST') {
      res.status(405).json({ 
        error: 'Method Not Allowed',
        code: 'METHOD_NOT_ALLOWED',
        message: 'Only POST requests are accepted' 
      });
      return;
    }

    // Rate limiting
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const requestCount = (rateLimitCache.get(ip) || 0) + 1;
    rateLimitCache.set(ip, requestCount);

    if (requestCount > 5) {
      res.status(429).json({
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        message: 'Limit: 5 requests per minute'
      });
      return;
    }

    // Parse request body
    let body;
    try {
      body = await req.json();
    } catch (parseError) {
      logError(parseError, { stage: 'body_parsing' });
      res.status(400).json({
        error: 'Invalid Request',
        code: 'INVALID_JSON',
        message: 'Request body must be valid JSON'
      });
      return;
    }

    // Validate ingredients
    if (!body?.ingredients?.trim()) {
      res.status(400).json({
        error: 'Invalid Input',
        code: 'MISSING_INGREDIENTS',
        message: 'Please provide at least one ingredient'
      });
      return;
    }

    // Verify OpenAI key
    if (!process.env.OPENAI_API_KEY) {
      const error = new Error('Missing OpenAI API Key');
      logError(error);
      res.status(500).json({
        error: 'Server Error',
        code: 'MISSING_API_KEY',
        message: 'Server configuration error'
      });
      return;
    }

    // Construct AI prompt
    const prompt = `As a diabetes nutritionist, create a recipe with these ingredients: ${body.ingredients}. 
    Requirements:
    - Diabetic-friendly (GI < 50)
    - Include nutritional analysis
    - Fun creative title
    - Format response as VALID JSON:
    {
      "title": "Recipe Name",
      "ingredients": {
        "provided": ["item with portion"],
        "optional": ["suggested additions"]
      },
      "instructions": ["step 1", "step 2"],
      "nutrition": {
        "carbs": "Xg",
        "protein": "Xg",
        "fat": "Xg",
        "calories": "X",
        "gi": X,
        "gl": X
      },
      "tips": "diabetes-friendly advice"
    }`;

    // Call OpenAI API
    const openAIResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5,
        max_tokens: 1000,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    ).catch(error => {
      logError(error, { stage: 'openai_api_call' });
      throw error;
    });

    // Validate OpenAI response
    const content = openAIResponse.data.choices[0]?.message?.content;
    if (!content) {
      const error = new Error('Empty response from OpenAI');
      logError(error);
      res.status(500).json({
        error: 'AI Service Error',
        code: 'EMPTY_AI_RESPONSE',
        message: 'No recipe generated'
      });
      return;
    }

    // Parse and validate recipe
    try {
      const recipe = JSON.parse(content);
      
      if (!recipe.title || !recipe.ingredients?.provided || !recipe.instructions) {
        throw new Error('Invalid recipe structure');
      }
      
      res.status(200).json(recipe);
    } catch (parseError) {
      logError(parseError, { content });
      res.status(500).json({
        error: 'Invalid Format',
        code: 'INVALID_RECIPE_FORMAT',
        message: 'Failed to parse recipe response'
      });
    }

  } catch (error) {
    logError(error, { stage: 'global_catch' });
    res.status(500).json({
      error: 'Server Error',
      code: 'INTERNAL_SERVER_ERROR',
      message: error.response?.data?.error?.message || 'An unexpected error occurred'
    });
  }
};
