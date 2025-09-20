// A robust, single-file serverless function for the AI Content Strategy Engine.
// This version uses Node.js's built-in fetch for cleaner, more reliable requests.

// --- API CLIENTS ---

/**
 * Fetches relevant videos from YouTube based on a search query.
 * @param {string} query The search term.
 * @param {string} apiKey Your YouTube Data API key.
 * @param {number} maxResults The number of results to return.
 * @returns {Promise<object[]>} A list of video titles.
 */
const searchYouTubeVideos = async (query, apiKey, maxResults = 3) => {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&order=relevance&maxResults=${maxResults}&key=${apiKey}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`YouTube API Error: ${response.statusText}`);
    const data = await response.json();
    return data.items?.map(item => ({ title: item.snippet.title })) || [];
  } catch (error) {
    console.error(`Error searching YouTube for "${query}":`, error.message);
    return [];
  }
};

/**
 * Fetches the latest videos from a specific YouTube channel by its name.
 * @param {string} channelName The name of the YouTube channel.
 * @param {string} apiKey Your YouTube Data API key.
 * @param {number} maxResults The number of results to return.
 * @returns {Promise<object[]>} A list of the channel's recent video titles.
 */
const getChannelVideos = async (channelName, apiKey, maxResults = 3) => {
  try {
    // Step 1: Find the channel ID from its name.
    const channelSearchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(channelName)}&type=channel&maxResults=1&key=${apiKey}`;
    const channelResponse = await fetch(channelSearchUrl).then(res => res.json());

    if (!channelResponse.items || channelResponse.items.length === 0) {
      console.warn(`YouTube channel not found: ${channelName}`);
      return [];
    }
    const channelId = channelResponse.items[0].id.channelId;

    // Step 2: Get the latest videos from that channel ID.
    const videosUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=${maxResults}&key=${apiKey}`;
    const videosResponse = await fetch(videosUrl).then(res => res.json());

    return videosResponse.items?.map(item => ({ title: item.snippet.title })) || [];
  } catch (error) {
    console.error(`Error fetching videos for channel "${channelName}":`, error.message);
    return [];
  }
};

// Simple in-memory cache for the Reddit token to avoid re-fetching on every call.
let redditToken = { value: null, expires: 0 };

/**
 * Gets a Reddit API access token, using a short-lived cache.
 * @param {string} clientId Your Reddit app's client ID.
 * @param {string} clientSecret Your Reddit app's client secret.
 * @returns {Promise<string|null>} The access token.
 */
const getRedditAccessToken = async (clientId, clientSecret) => {
  if (redditToken.value && redditToken.expires > Date.now()) {
    return redditToken.value;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const url = 'https://www.reddit.com/api/v1/access_token';
  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'VercelContentStrategyEngine/1.0',
    },
    body: 'grant_type=client_credentials',
  };

  try {
    const response = await fetch(url, options).then(res => res.json());
    if (!response.access_token) throw new Error('Reddit token not received.');
    
    // Cache the token for 50 minutes (it expires in 60).
    redditToken = {
      value: response.access_token,
      expires: Date.now() + 50 * 60 * 1000,
    };
    return redditToken.value;
  } catch (error) {
    console.error('Reddit token error:', error.message);
    return null;
  }
};

/**
 * Gets the top posts from a given subreddit.
 * @param {string} subreddit The name of the subreddit (without 'r/').
 * @param {string} accessToken A valid Reddit API access token.
 * @param {number} limit The number of posts to fetch.
 * @returns {Promise<object[]>} A list of post titles.
 */
const getSubredditPosts = async (subreddit, accessToken, limit = 3) => {
  const url = `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}`;
  const options = {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'VercelContentStrategyEngine/1.0',
    },
  };

  try {
    const response = await fetch(url, options).then(res => res.json());
    return response.data?.children?.map(post => ({ title: post.data.title })) || [];
  } catch (error) {
    console.error(`Error fetching posts from r/${subreddit}:`, error.message);
    return [];
  }
};

/**
 * Calls the Gemini API with the master prompt to generate the content strategy.
 * @param {string} prompt The complete, detailed master prompt.
 * @param {string} apiKey Your Gemini API key.
 * @returns {Promise<object>} The final JSON object containing the strategy.
 */
const callGeminiAPI = async (prompt, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" } // Ask for JSON directly
  };

  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  };

  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Gemini API Error: ${response.statusText}`);
    const data = await response.json();
    // The response is already parsed JSON because of the responseMimeType config.
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('Gemini API error:', error.message);
    throw new Error('Failed to get a valid response from the Gemini API.');
  }
};

// --- MAIN SERVERLESS HANDLER ---

module.exports = async (req, res) => {
  // Set CORS headers to allow requests from any origin (for development)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { audience, goal, competitorYouTubeChannels, relevantSubreddits } = req.body || {};

    // --- Input Validation ---
    if (!audience || !goal || !Array.isArray(competitorYouTubeChannels) || !Array.isArray(relevantSubreddits)) {
      return res.status(400).json({ error: 'Invalid request body. Ensure all required fields are present.' });
    }
    
    const { YOUTUBE_API_KEY, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, GEMINI_API_KEY } = process.env;
    if (!YOUTUBE_API_KEY || !REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET || !GEMINI_API_KEY) {
      console.error("CRITICAL: Missing one or more environment variables.");
      return res.status(500).json({ error: 'Server configuration error.' });
    }

    // --- Phase 1: Data Collection ---
    console.log("Phase 1: Starting data collection...");

    const [topVideos, competitorVideosData, redditPostsData] = await Promise.all([
      searchYouTubeVideos(`${audience} ${goal}`, YOUTUBE_API_KEY, 3),
      Promise.all(competitorYouTubeChannels.map(channel => getChannelVideos(channel, YOUTUBE_API_KEY, 3).then(videos => ({ channel, videos })))),
      getRedditAccessToken(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET).then(token => 
        token ? Promise.all(relevantSubreddits.map(sub => getSubredditPosts(sub, token, 3).then(posts => ({ subreddit: sub, posts })))) : []
      )
    ]);

    // --- Phase 2: Prompt Construction ---
    console.log("Phase 2: Constructing master prompt...");
    
    const topVideoTitles = topVideos.map(v => v.title).join(', ');
    const competitorVideoTitles = competitorVideosData.map(c => `${c.channel}: ${c.videos.map(v => v.title).join(', ')}`).join(' | ');
    const redditPostTitles = redditPostsData.map(s => `r/${s.subreddit}: ${s.posts.map(p => p.title).join(', ')}`).join(' | ');

    const masterPrompt = `
You are a world-class content strategist and data analyst. I have gathered real-time data from YouTube and Reddit for a client. Your task is to generate a complete content strategy based on this data and your own expert knowledge.

Client Details:
- Target Audience: ${audience}
- Primary Goal: ${goal}

Live Data Collected:
- Top YouTube Videos: ${topVideoTitles || "N/A"}
- Competitor YouTube Videos: ${competitorVideoTitles || "N/A"}
- Top Reddit Posts: ${redditPostTitles || "N/A"}

Based on all of this, provide a response in a single JSON object with the following four keys: "trendDiscovery", "contentAnalysis", "competitorReport", "strategyCalendar".

1.  "trendDiscovery": An object containing trend analysis from four key platforms.
    - "youtubeTrends": Analyze the provided YouTube data to identify 3-5 key trends.
    - "redditTrends": Analyze the provided Reddit data to identify 3-5 key community topics and sentiments.
    - "simulatedXTrends": Act as an expert on X (Twitter). Based on your knowledge, simulate the top 3-5 trending topics and content formats (e.g., threads, memes) relevant to the target audience on X right now.
    - "simulatedGoogleTrends": Act as an expert search analyst. Based on your knowledge, simulate the top 3-5 rising search queries on Google Trends relevant to the target audience.

2.  "contentAnalysis": An object that deconstructs what makes high-performing content successful.
    - "winningFormats": Identify the most effective content formats (e.g., YouTube Shorts, long-form video) based on all available data.
    - "toneOfVoice": Describe the most successful tone of voice (e.g., 'humorous and informal', 'educational and authoritative').
    - "engagementTriggers": List common engagement triggers found in the content (e.g., 'asking a direct question', 'hosting a challenge').
    - "optimalTiming": Suggest the best days and times to post, providing a rationale.

3.  "competitorReport": An object analyzing the specified competitors.
    - "youtubeCompetitorAnalysis": Analyze the provided competitor YouTube video titles. Summarize their content strategy, topic focus, and posting frequency.
    - "inferredXStrategy": Based on their known strategy, infer what their strategy on X would likely be.

4.  "strategyCalendar": An array of 30 objects, representing a full 30-day content plan. Each object in the array must have the following structure: { "day": number, "platform": "YouTube/Instagram/Reddit", "title": "A catchy, fully-formed content title", "format": "e.g., YouTube Short, IG Reel, Reddit Thread", "description": "A 1-2 sentence description of the content piece." }
`;

    // --- Phase 3: AI Analysis ---
    console.log("Phase 3: Calling Gemini API for final analysis...");
    
    const geminiResponse = await callGeminiAPI(masterPrompt, GEMINI_API_KEY);

    // --- Final Response ---
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(geminiResponse);

  } catch (error) {
    console.error("FATAL_ERROR in handler:", error);
    res.status(500).json({ error: 'An internal server error occurred.', details: error.message });
  }
};
