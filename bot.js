// MBTA Bluesky Bot
// This bot fetches MBTA service alerts and posts them to Bluesky

import { BskyAgent } from '@atproto/api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

class MBTABlueskyBot {
  constructor() {
    this.agent = new BskyAgent({
      service: 'https://bsky.social'
    });
    
    // MBTA API Configuration
    this.mbtaApiKey = process.env.MBTA_API_KEY; // Optional but recommended
    this.mbtaBaseUrl = 'https://api-v3.mbta.com';
    
    // Bluesky credentials
    this.blueskyHandle = process.env.BLUESKY_HANDLE;
    this.blueskyPassword = process.env.BLUESKY_PASSWORD;
    
    // Track posted alerts to avoid duplicates
    this.postedAlerts = new Set();
  }

  async initialize() {
    try {
      // Check if credentials are loaded
      if (!this.blueskyHandle || !this.blueskyPassword) {
        throw new Error('Missing Bluesky credentials. Please check your .env file.');
      }
      
      console.log(`Attempting to login with handle: ${this.blueskyHandle}`);
      
      await this.agent.login({
        identifier: this.blueskyHandle,
        password: this.blueskyPassword
      });
      console.log('Successfully logged into Bluesky');
    } catch (error) {
      console.error('Failed to login to Bluesky:', error);
      console.error('Make sure your .env file contains:');
      console.error('BLUESKY_HANDLE=your-bot-handle.bsky.social');
      console.error('BLUESKY_PASSWORD=your_bot_password');
      throw error;
    }
  }

  async fetchMBTAAlerts() {
    try {
      const headers = {};
      if (this.mbtaApiKey) {
        headers['X-API-Key'] = this.mbtaApiKey;
      }

      const response = await fetch(`${this.mbtaBaseUrl}/alerts?filter[activity]=BOARD,EXIT,RIDE&include=routes,stops,facilities`, {
        headers
      });

      if (!response.ok) {
        throw new Error(`MBTA API error: ${response.status}`);
      }

      const data = await response.json();
      return data.data || [];
    } catch (error) {
      console.error('Error fetching MBTA alerts:', error);
      return [];
    }
  }

  async fetchServiceStatus() {
    try {
      const headers = {};
      if (this.mbtaApiKey) {
        headers['X-API-Key'] = this.mbtaApiKey;
      }

      // Get predictions for major subway lines
      const routes = ['Red', 'Blue', 'Orange', 'Green-B', 'Green-C', 'Green-D', 'Green-E'];
      const predictions = await Promise.all(
        routes.map(async (route) => {
          const response = await fetch(`${this.mbtaBaseUrl}/predictions?filter[route]=${route}&page[limit]=5`, {
            headers
          });
          const data = await response.json();
          return { route, predictions: data.data || [] };
        })
      );

      return predictions;
    } catch (error) {
      console.error('Error fetching service status:', error);
      return [];
    }
  }

  formatAlert(alert) {
    const severity = alert.attributes.severity;
    const emoji = this.getSeverityEmoji(severity);
    
    let message = `${emoji} MBTA Alert\n\n`;
    
    // Add header
    if (alert.attributes.header) {
      message += `${alert.attributes.header}\n\n`;
    }
    
    // Add description (truncated if too long)
    if (alert.attributes.description) {
      let description = alert.attributes.description;
      if (description.length > 200) {
        description = description.substring(0, 200) + '...';
      }
      message += `${description}\n\n`;
    }
    
    // Add affected routes/services
    if (alert.relationships && alert.relationships.routes) {
      const routeCount = alert.relationships.routes.data.length;
      if (routeCount > 0) {
        message += `Affected routes: ${routeCount} route${routeCount > 1 ? 's' : ''}\n`;
      }
    }
    
    // Add severity
    message += `Severity: ${severity}\n`;
    
    // Add timestamp
    const now = new Date().toLocaleString();
    message += `Updated: ${now}`;
    
    return message;
  }

  getSeverityEmoji(severity) {
    switch (severity) {
      case 'SEVERE':
        return '🚨';
      case 'HIGH':
        return '⚠️';
      case 'MEDIUM':
        return '⚡';
      case 'LOW':
        return 'ℹ️';
      default:
        return '📢';
    }
  }

  async postToBluesky(message) {
    try {
      await this.agent.post({
        text: message,
        createdAt: new Date().toISOString()
      });
      console.log('Successfully posted to Bluesky');
    } catch (error) {
      console.error('Error posting to Bluesky:', error);
    }
  }

  async postServiceStatus() {
    try {
      const serviceData = await this.fetchServiceStatus();
      
      if (serviceData.length === 0) {
        return;
      }

      let message = '🚇 MBTA Service Status Update\n\n';
      
      for (const { route, predictions } of serviceData) {
        const activePredictions = predictions.filter(p => p.attributes && p.attributes.departure_time);
        
        if (activePredictions.length > 0) {
          message += `${route} Line: ✅ Active\n`;
        } else {
          message += `${route} Line: ❓ Limited/No Data\n`;
        }
      }
      
      message += '\n' + new Date().toLocaleString();
      
      await this.postToBluesky(message);
    } catch (error) {
      console.error('Error posting service status:', error);
    }
  }

  async checkAndPostAlerts() {
    try {
      const alerts = await this.fetchMBTAAlerts();
      
      for (const alert of alerts) {
        const alertId = alert.id;
        
        // Skip if we've already posted this alert
        if (this.postedAlerts.has(alertId)) {
          continue;
        }
        
        // Only post significant alerts
        const severity = alert.attributes.severity;
        if (['SEVERE', 'HIGH'].includes(severity)) {
          const message = this.formatAlert(alert);
          await this.postToBluesky(message);
          this.postedAlerts.add(alertId);
          
          // Add delay between posts
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      // Clean up old alert IDs (keep only last 100)
      if (this.postedAlerts.size > 100) {
        const alertArray = Array.from(this.postedAlerts);
        this.postedAlerts = new Set(alertArray.slice(-100));
      }
      
    } catch (error) {
      console.error('Error checking alerts:', error);
    }
  }

  async run() {
    console.log('Starting MBTA Bluesky Bot...');
    
    await this.initialize();
    
    // Post initial service status
    await this.postServiceStatus();
    
    // Set up intervals
    setInterval(async () => {
      await this.checkAndPostAlerts();
    }, 5 * 60 * 1000); // Check for alerts every 5 minutes
    
    setInterval(async () => {
      await this.postServiceStatus();
    }, 60 * 60 * 1000); // Post service status every hour
    
    console.log('Bot is running! Press Ctrl+C to stop.');
  }
}

// Environment setup and bot initialization
if (process.env.NODE_ENV !== 'test') {
  const bot = new MBTABlueskyBot();
  bot.run().catch(console.error);
}

export default MBTABlueskyBot;
