// Discord Bot for Boss Respawn Tracker
// Requires: Node.js, discord.js, node-fetch, dotenv

require('./keep_alive.js');

const { Client, Intents, MessageEmbed } = require('discord.js');
const fetch = require('node-fetch');
require('dotenv').config();

// Bot configuration
const client = new Client({ 
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES
    ] 
});

// Google Sheet URL
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSD24PDvrAwLaNKdMM2lKhe_MuR_jDut6NUsDKBnowZxhrVEMFck_9LPovBdOjAfpJRE_v5RkYbvh2r/pub?output=csv';

// Boss data storage
let bossData = [];
let lastUpdated = null;

// Parse CSV data
function parseCSV(csvText) {
    const lines = csvText.split('\n');
    const result = [];
    
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Parse CSV values handling quoted fields
        const values = [];
        let currentValue = '';
        let inQuotes = false;
        
        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                values.push(currentValue.trim());
                currentValue = '';
            } else {
                currentValue += char;
            }
        }
        values.push(currentValue.trim());
        
        // Process the row data
        if (values.length >= 10) {
            // Check if it's a fixed boss row
            const isFixedBoss = values[3] === 'Fixed';
            
            // Combine date and time for last killed and respawn time
            const lastKilled = values[3] && values[4] ? `${values[3]} ${values[4]}` : values[3] || '';
            const respawnTime = values[6] && values[7] ? `${values[6]} ${values[7]}` : values[6] || '';
            
            result.push({
                map: values[0] || '',
                level: parseInt(values[1]) || 0,
                name: values[2] || '',
                lastKilled: lastKilled,
                cooldown: values[5] || '',
                respawnTime: respawnTime,
                note: values[9] || '',
                type: isFixedBoss ? 'fixed' : 'regular'
            });
        }
    }
    
    return result;
}

// Calculate time remaining for a boss
function getTimeRemaining(boss) {
    if (boss.type === 'regular' && boss.respawnTime) {
        // Handle different date formats
        let respawnDate;
        if (boss.respawnTime.includes('/')) {
            // Format: DD/MM/YYYY HH:MM
            respawnDate = new Date(boss.respawnTime.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
        } else {
            // Format: HH:MM or other
            respawnDate = new Date(boss.respawnTime);
        }
        
        const now = new Date();
        const diff = respawnDate - now;
        
        if (isNaN(diff)) {
            return { text: 'Invalid Date', class: 'long' };
        } else if (diff <= 0) {
            return { text: 'READY NOW', class: 'ready' };
        } else {
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);
            
            let timeClass = 'long';
            if (hours < 1) {
                timeClass = 'soon';
            }
            
            return { 
                text: `${hours}h ${minutes}m ${seconds}s`, 
                class: timeClass,
                totalMs: diff
            };
        }
    } else if (boss.type === 'fixed') {
        return { text: 'Fixed Schedule', class: 'fixed' };
    } else {
        return { text: 'Unknown', class: 'long' };
    }
}

// Fetch boss data from Google Sheet
async function fetchBossData() {
    try {
        const response = await fetch(SPREADSHEET_URL);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        const csvText = await response.text();
        bossData = parseCSV(csvText);
        lastUpdated = new Date();
        console.log(`Boss data updated at ${lastUpdated.toLocaleString()}`);
        return true;
    } catch (error) {
        console.error('Error fetching data:', error);
        return false;
    }
}

// Get ready bosses
function getReadyBosses() {
    return bossData.filter(boss => {
        if (boss.type === 'fixed') return false;
        
        const timeRemaining = getTimeRemaining(boss);
        return timeRemaining.class === 'ready';
    });
}

// Get next bosses (up to 2)
function getNextBosses() {
    const upcomingBosses = [];
    
    bossData.forEach(boss => {
        if (boss.type === 'fixed') return;
        
        const timeRemaining = getTimeRemaining(boss);
        if (timeRemaining.class !== 'ready' && timeRemaining.totalMs) {
            upcomingBosses.push({
                boss,
                timeRemaining: timeRemaining.totalMs
            });
        }
    });
    
    // Sort by time remaining
    upcomingBosses.sort((a, b) => a.timeRemaining - b.timeRemaining);
    
    // Return up to 2 bosses
    return upcomingBosses.slice(0, 2);
}

// Find boss by name
function findBossByName(name) {
    return bossData.find(boss => 
        boss.name.toLowerCase().includes(name.toLowerCase())
    );
}

// Format boss info for Discord
function formatBossInfo(boss) {
    const timeRemaining = getTimeRemaining(boss);
    
    let embed = new MessageEmbed()
        .setTitle(`${boss.name} (Level ${boss.level})`)
        .addField('Map', boss.map, true)
        .addField('Type', boss.type === 'fixed' ? 'Fixed Schedule' : 'Regular', true)
        .addField('Last Killed', boss.lastKilled || 'N/A', true)
        .addField('Respawn Time', boss.respawnTime || 'N/A', true)
        .addField('Time Remaining', timeRemaining.text, true);
    
    if (boss.note) {
        embed.addField('Note', boss.note);
    }
    
    // Set color based on time remaining
    if (timeRemaining.class === 'ready') {
        embed.setColor('#3fb950'); // Green
    } else if (timeRemaining.class === 'soon') {
        embed.setColor('#d29922'); // Yellow/Orange
    } else {
        embed.setColor('#58a6ff'); // Blue
    }
    
    return embed;
}

// Bot commands
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;
    
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    if (command === 'ready') {
        const readyBosses = getReadyBosses();
        
        if (readyBosses.length === 0) {
            return message.channel.send('No bosses are ready at the moment.');
        }
        
        const embed = new MessageEmbed()
            .setTitle('Ready Bosses')
            .setColor('#3fb950') // Green
            .setDescription('The following bosses are ready to fight:')
            .setFooter(`Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}`);
        
        readyBosses.forEach(boss => {
            embed.addField(boss.name, `${boss.map} (Level ${boss.level})`, true);
        });
        
        message.channel.send({ embeds: [embed] });
    }
    
    else if (command === 'next') {
        const nextBosses = getNextBosses();
        
        if (nextBosses.length === 0) {
            return message.channel.send('No upcoming bosses found.');
        }
        
        const embed = new MessageEmbed()
            .setTitle('Next Bosses Spawning')
            .setColor('#d29922') // Yellow/Orange
            .setDescription('The next bosses to spawn are:')
            .setFooter(`Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}`);
        
        nextBosses.forEach(({ boss, timeRemaining }) => {
            const hours = Math.floor(timeRemaining / (1000 * 60 * 60));
            const minutes = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((timeRemaining % (1000 * 60)) / 1000);
            
            embed.addField(
                boss.name, 
                `${boss.map} (Level ${boss.level})\nTime: ${hours}h ${minutes}m ${seconds}s`,
                true
            );
        });
        
        message.channel.send({ embeds: [embed] });
    }
    
    else if (command === 'boss') {
        if (!args.length) {
            return message.channel.send('Please provide a boss name. Usage: `!boss [name]`');
        }
        
        const bossName = args.join(' ');
        const boss = findBossByName(bossName);
        
        if (!boss) {
            return message.channel.send(`Boss "${bossName}" not found.`);
        }
        
        const embed = formatBossInfo(boss)
            .setFooter(`Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}`);
        
        message.channel.send({ embeds: [embed] });
    }
    
    else if (command === 'list') {
        if (bossData.length === 0) {
            return message.channel.send('No boss data available. Try again later.');
        }
        
        // Create paginated embeds for the list
        const itemsPerPage = 10;
        const pages = Math.ceil(bossData.length / itemsPerPage);
        let page = 1;
        
        if (args.length && !isNaN(parseInt(args[0]))) {
            page = Math.max(1, Math.min(pages, parseInt(args[0])));
        }
        
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, bossData.length);
        const pageBosses = bossData.slice(startIndex, endIndex);
        
        const embed = new MessageEmbed()
            .setTitle('Boss List')
            .setColor('#58a6ff') // Blue
            .setDescription(`Showing bosses ${startIndex + 1}-${endIndex} of ${bossData.length}`)
            .setFooter(`Page ${page} of ${pages} • Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}`);
        
        pageBosses.forEach(boss => {
            const timeRemaining = getTimeRemaining(boss);
            embed.addField(
                `${boss.name} (Level ${boss.level})`,
                `${boss.map} • ${timeRemaining.text}`,
                false
            );
        });
        
        message.channel.send({ embeds: [embed] });
    }
    
    else if (command === 'help') {
        const embed = new MessageEmbed()
            .setTitle('Boss Respawn Tracker - Help')
            .setColor('#58a6ff') // Blue
            .setDescription('Available commands:')
            .addField('!ready', 'Shows bosses that are ready to fight now')
            .addField('!next', 'Shows the next 2 bosses that will spawn')
            .addField('!boss [name]', 'Shows information about a specific boss')
            .addField('!list [page]', 'Shows all bosses with respawn times (paginated)')
            .addField('!help', 'Shows this help message')
            .addField('!update', 'Forces an update of the boss data (admin only)')
            .setFooter('Data from Volvie\'s Spreadsheet');
        
        message.channel.send({ embeds: [embed] });
    }
    
    else if (command === 'update') {
        // Simple admin check (you might want to implement proper permissions)
        if (!message.member.permissions.has('ADMINISTRATOR')) {
            return message.channel.send('You do not have permission to use this command.');
        }
        
        const success = await fetchBossData();
        if (success) {
            message.channel.send('Boss data has been updated successfully!');
        } else {
            message.channel.send('Failed to update boss data. Please try again later.');
        }
    }
});

// Bot ready event
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    
    // Initial data fetch
    fetchBossData();
    
    // Set up periodic data refresh (every 5 minutes)
    setInterval(fetchBossData, 5 * 60 * 1000);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN);
