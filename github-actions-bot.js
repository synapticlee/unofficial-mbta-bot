// github-actions-bot.js
// Modified version of the MBTA bot for GitHub Actions (runs once per execution)

import { BskyAgent } from '@atproto/api';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

class MBTABlueskyBotGitHubActions {
  constructor() {
    this.agent = new BskyAgent({
      service: 'https://bsky.social'
    });
    
    // Get credentials from environment variables (GitHub Secrets)
    this.mbtaApiKey = process.env.MBTA_API_KEY;
    this.blueskyHandle = process.env.BLUESKY_HANDLE;
    this.blueskyPassword = process.env.BLUESKY_PASSWORD;
    
    // File to track posted alerts (persists between runs)
    this.alertsFile = 'posted-alerts.json';
    this.postedAlerts = this.loadPostedAlerts();
  }

  loadPostedAlerts() {
    try {
      if (fs.existsSync(this.alertsFile)) {
        const data = fs.readFileSync(this.alertsFile, 'utf8');
        return new Set(JSON.parse(data));
      }
    } catch (error) {
      console.log('No previous alerts file found, starting fresh');
    }
    return new Set();
  }

  savePostedAlerts() {
    try {
      fs.writeFileSync(this.alertsFile, JSON.stringify([...this.postedAlerts]));
    } catch (error) {
      console.error('Error saving posted alerts:', error);
    }
  }

  async initialize() {
    try {
      if (!this.blueskyHandle || !this.blueskyPassword) {
        throw new Error('Missing Bluesky credentials in GitHub Secrets');
      }
      
      console.log(`Logging into Bluesky as: ${this.blueskyHandle}`);
      
      await this.agent.login({
        identifier: this.blueskyHandle,
        password: this.blueskyPassword
      });
      
      console.log('Successfully logged into Bluesky');
    } catch (error) {
      console.error('Failed to login to Bluesky:', error);
      throw error;
    }
  }

  async fetchMBTAAlerts() {
    try {
      const headers = {};
      if (this.mbtaApiKey) {
        headers['X-API-Key'] = this.mbtaApiKey;
      }

      const response = await fetch(`https://api-v3.mbta.com/alerts?filter[activity]=BOARD,EXIT,RIDE&include=routes,stops,facilities`, {
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

      const routes = ['Red', 'Blue', 'Orange', 'Green-B', 'Green-C', 'Green-D', 'Green-E'];
      const predictions = await Promise.all(
        routes.map(async (route) => {
          try {
            const response = await fetch(`https://api-v3.mbta.com/predictions?filter[route]=${route}&page[limit]=5`, {
              headers
            });
            const data = await response.json();
            return { route, predictions: data.data || [] };
          } catch (error) {
            console.error(`Error fetching ${route} predictions:`, error);
            return { route, predictions: [] };
          }
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
    
    if (alert.attributes.header) {
      message += `${alert.attributes.header}\n\n`;
    }
    
    if (alert.attributes.description) {
      let description = alert.attributes.description;
      if (description.length > 200) {
        description = description.substring(0, 200) + '...';
      }
      message += `${description}\n\n`;
    }
    
    if (alert.relationships && alert.relationships.routes) {
      const routeCount = alert.relationships.routes.data.length;
      if (routeCount > 0) {
        message += `Affected routes: ${routeCount} route${routeCount > 1 ? 's' : ''}\n`;
      }
    }
    
    message += `Severity: ${severity}\n`;
    message += `Updated: ${new Date().toLocaleString()}\n`;
    message += `\n🤖 Automated via GitHub Actions`;
    
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
      return true;
    } catch (error) {
      console.error('Error posting to Bluesky:', error);
      return false;
    }
  }

  async checkAndPostAlerts() {
    try {
      const alerts = await this.fetchMBTAAlerts();
      let postedCount = 0;
      
      console.log(`Found ${alerts.length} total alerts`);
      
      for (const alert of alerts) {
        const alertId = alert.id;
        
        // Skip if already posted
        if (this.postedAlerts.has(alertId)) {
          continue;
        }
        
        const severity = alert.attributes.severity;
        
        // Post high priority alerts
        if (['SEVERE', 'HIGH'].includes(severity)) {
          console.log(`Posting ${severity} alert: ${alertId}`);
          const message = this.formatAlert(alert);
          
          if (await this.postToBluesky(message)) {
            this.postedAlerts.add(alertId);
            postedCount++;
            
            // Add delay between posts
            if (postedCount < alerts.length) {
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }
        }
      }
      
      console.log(`Posted ${postedCount} new alerts`);
      
      // Clean up old alerts (keep last 50)
      if (this.postedAlerts.size > 50) {
        const alertArray = Array.from(this.postedAlerts);
        this.postedAlerts = new Set(alertArray.slice(-50));
      }
      
      this.savePostedAlerts();
      
    } catch (error) {
      console.error('Error checking alerts:', error);
    }
  }

  async postServiceStatus() {
    try {
      const serviceData = await this.fetchServiceStatus();
      
      if (serviceData.length === 0) {
        console.log('No service data available');
        return;
      }

      let message = '🚇 MBTA Service Status\n\n';
      
      for (const { route, predictions } of serviceData) {
        const activePredictions = predictions.filter(p => p.attributes && p.attributes.departure_time);
        
        if (activePredictions.length > 0) {
          message += `${route} Line: ✅ Active\n`;
        } else {
          message += `${route} Line: ❓ Limited Data\n`;
        }
      }
      
      message += `\n${new Date().toLocaleString()}`;
      message += `\n🤖 Automated via GitHub Actions`;
      
      await this.postToBluesky(message);
      
    } catch (error) {
      console.error('Error posting service status:', error);
    }
  }

  async run() {
    try {
      console.log('Starting MBTA Bot (GitHub Actions mode)');
      
      await this.initialize();
      
      // Determine what to do based on the current minute
      const now = new Date();
      const minute = now.getMinutes();
      
      // Post service status every hour (at minute 0)
      if (minute === 0) {
        console.log('Posting hourly service status');
        await this.postServiceStatus();
      }
      
      // Always check for alerts
      console.log('Checking for alerts');
      await this.checkAndPostAlerts();
      
      console.log('Bot run completed');
      
    } catch (error) {
      console.error('Bot run failed:', error);
      process.exit(1);
    }
  }
}

// Run the bot
const bot = new MBTABlueskyBotGitHubActions();
bot.run().catch(console.error);
