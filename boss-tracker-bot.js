// Discord Bot for Boss Respawn Tracker
// Requires: Node.js, discord.js, node-fetch, dotenv
require('./keep_alive.js');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
require('dotenv').config();

// Bot configuration
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
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
        if (values.length >= 9) {
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
                note: values[8] || '',
                type: isFixedBoss ? 'fixed' : 'regular'
            });
        }
    }

    return result;
}

// Extract time remaining from note and calculate milliseconds
function extractTimeFromNote(note) {
    if (!note) return null;

    // Check if the note indicates the boss is ready now
    if (note.toLowerCase().includes('ready') || note.toLowerCase().includes('now')) {
        return { text: 'READY NOW', class: 'ready', totalMs: 0 };
    }

    // Look for time patterns in the note
    const patterns = [
        { regex: /(\d+)\s*min\s*left/i, multiplier: 60 * 1000 },    // "23min left"
        { regex: /(\d+h\s*\d+m)\s*left/i, multiplier: 1000 }, // "1h48m left"
        { regex: /(\d+h)\s*left/i, multiplier: 60 * 60 * 1000 },       // "5h left"
        { regex: /(\d+h\s*\d+m)/i, multiplier: 1000 },       // "1h48m" (without "left")
        { regex: /(\d+)\s*min/i, multiplier: 60 * 1000 },         // "23min" (without "left")
        { regex: /(\d+h)/i, multiplier: 60 * 60 * 1000 }              // "5h" (without "left")
    ];

    for (const { regex, multiplier } of patterns) {
        const match = note.match(regex);
        if (match) {
            const timeText = match[1].trim();

            // Parse the time to calculate milliseconds
            let totalMs = 0;

            if (timeText.includes('h') && timeText.includes('m')) {
                // Format: "1h48m"
                const [hours, minutes] = timeText.split('h');
                const h = parseInt(hours);
                const m = parseInt(minutes.replace('m', ''));
                totalMs = (h * 60 + m) * 60 * 1000;
            } else if (timeText.includes('h')) {
                // Format: "5h"
                const h = parseInt(timeText.replace('h', ''));
                totalMs = h * 60 * 60 * 1000;
            } else if (timeText.includes('m')) {
                // Format: "23min"
                const m = parseInt(timeText.replace('min', ''));
                totalMs = m * 60 * 1000;
            }

            // Determine class based on time format
            let timeClass = 'long';
            if (totalMs < 60 * 60 * 1000) { // Less than 1 hour
                timeClass = 'soon';
            }

            return { text: timeText, class: timeClass, totalMs };
        }
    }

    return null;
}

// Parse date in format "HH:MM DD/MM/YYYY" (time first, then date)
function parseCustomDateTime(dateTimeStr) {
    if (!dateTimeStr) return null;

    // Split the string to separate time and date
    const parts = dateTimeStr.split(' ');
    if (parts.length < 2) return null;

    // The first part is the time (HH:MM)
    const timePart = parts[0];
    // The remaining parts form the date (DD/MM/YYYY)
    const datePart = parts.slice(1).join(' ');

    // Parse the time
    const [hours, minutes] = timePart.split(':').map(Number);

    // Parse the date
    const [day, month, year] = datePart.split('/').map(Number);

    // Create a new Date object
    // Note: Month is 0-indexed in JavaScript Date
    const date = new Date(year, month - 1, day, hours, minutes);

    return date;
}

// Calculate time remaining for a boss
function getTimeRemaining(boss) {
    if (boss.type === 'fixed') {
        return { text: 'Fixed Schedule', class: 'fixed', totalMs: null };
    }

    // Priority 1: Use the note field (this is what's shown in the spreadsheet)
    const timeFromNote = extractTimeFromNote(boss.note);
    if (timeFromNote) {
        return timeFromNote;
    }

    // Priority 2: Use respawn time from spreadsheet to calculate current time remaining
    if (boss.type === 'regular' && boss.respawnTime) {
        // Parse the respawn time using our custom parser
        const respawnDate = parseCustomDateTime(boss.respawnTime);

        if (respawnDate && !isNaN(respawnDate.getTime())) {
            const now = new Date();
            const diff = respawnDate - now;

            if (diff <= 0) {
                return { text: 'READY NOW', class: 'ready', totalMs: 0 };
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
        }
    }

    // Priority 3: Use last killed + cooldown to calculate respawn time
    if (boss.type === 'regular' && boss.lastKilled && boss.cooldown) {
        // Calculate respawn time from last killed and cooldown
        const lastKilledDate = parseCustomDateTime(boss.lastKilled);

        if (lastKilledDate && !isNaN(lastKilledDate.getTime())) {
            const [hours, minutes] = boss.cooldown.split(':').map(Number);
            const respawnDate = new Date(lastKilledDate.getTime() + (hours * 60 + minutes) * 60000);

            const now = new Date();
            const diff = respawnDate - now;

            if (diff <= 0) {
                return { text: 'READY NOW', class: 'ready', totalMs: 0 };
            } else {
                const h = Math.floor(diff / (1000 * 60 * 60));
                const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                const s = Math.floor((diff % (1000 * 60)) / 1000);

                let timeClass = 'long';
                if (h < 1) {
                    timeClass = 'soon';
                }

                return { 
                    text: `${h}h ${m}m ${s}s`, 
                    class: timeClass,
                    totalMs: diff
                };
            }
        }
    }

    return { text: 'Unknown', class: 'long', totalMs: null };
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

        // Debug: Log the first boss to check parsing
        if (bossData.length > 0) {
            const venatus = bossData.find(b => b.name === 'Venatus');
            if (venatus) {
                console.log('Venatus debug:');
                console.log('  respawnTime:', venatus.respawnTime);
                console.log('  parsed respawnDate:', parseCustomDateTime(venatus.respawnTime));
                console.log('  lastKilled:', venatus.lastKilled);
                console.log('  cooldown:', venatus.cooldown);
                console.log('  note:', venatus.note);
                const timeRemaining = getTimeRemaining(venatus);
                console.log('  calculated time:', timeRemaining.text);
                console.log('  totalMs:', timeRemaining.totalMs);
            }
        }

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
        if (timeRemaining.class !== 'ready' && timeRemaining.class !== 'fixed' && timeRemaining.totalMs !== null) {
            upcomingBosses.push({
                boss,
                timeRemaining: timeRemaining.totalMs,
                displayText: timeRemaining.text
            });
        }
    });

    // Sort by time remaining (ascending - smallest time first)
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

    let embed = new EmbedBuilder()
        .setTitle(`${boss.name} (Level ${boss.level})`)
        .addFields(
            { name: 'Map', value: boss.map, inline: true },
            { name: 'Type', value: boss.type === 'fixed' ? 'Fixed Schedule' : 'Regular', inline: true },
            { name: 'Last Killed', value: boss.lastKilled || 'N/A', inline: true },
            { name: 'Respawn Time', value: boss.respawnTime || 'N/A', inline: true },
            { name: 'Time Remaining', value: timeRemaining.text, inline: true }
        );

    if (boss.note) {
        embed.addFields({ name: 'Note', value: boss.note });
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

        const embed = new EmbedBuilder()
            .setTitle('Ready Bosses')
            .setColor('#3fb950') // Green
            .setDescription('The following bosses are ready to fight:')
            .setFooter({ text: `Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}` });

        readyBosses.forEach(boss => {
            embed.addFields({ name: boss.name, value: `${boss.map} (Level ${boss.level})`, inline: true });
        });

        message.channel.send({ embeds: [embed] });
    }

    else if (command === 'next') {
        const nextBosses = getNextBosses();

        if (nextBosses.length === 0) {
            return message.channel.send('No upcoming bosses found.');
        }

        const embed = new EmbedBuilder()
            .setTitle('Next Bosses Spawning')
            .setColor('#d29922') // Yellow/Orange
            .setDescription('The next bosses to spawn are:')
            .setFooter({ text: `Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}` });

        nextBosses.forEach(({ boss, displayText }) => {
            embed.addFields(
                { name: boss.name, value: `${boss.map} (Level ${boss.level})\nTime: ${displayText}`, inline: true }
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
            .setFooter({ text: `Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}` });

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

        const embed = new EmbedBuilder()
            .setTitle('Boss List')
            .setColor('#58a6ff') // Blue
            .setDescription(`Showing bosses ${startIndex + 1}-${endIndex} of ${bossData.length}`)
            .setFooter({ text: `Page ${page} of ${pages} • Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}` });

        pageBosses.forEach(boss => {
            const timeRemaining = getTimeRemaining(boss);
            embed.addFields(
                { name: `${boss.name} (Level ${boss.level})`, value: `${boss.map} • ${timeRemaining.text}`, inline: false }
            );
        });

        message.channel.send({ embeds: [embed] });
    }

    else if (command === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('Boss Respawn Tracker - Help')
            .setColor('#58a6ff') // Blue
            .setDescription('Available commands:')
            .addFields(
                { name: '!ready', value: 'Shows bosses that are ready to fight now' },
                { name: '!next', value: 'Shows the next 2 bosses that will spawn' },
                { name: '!boss [name]', value: 'Shows information about a specific boss' },
                { name: '!list [page]', value: 'Shows all bosses with respawn times (paginated)' },
                { name: '!update', value: 'Forces an update of the boss data (admin only)' },
                { name: '!debug', value: 'Shows debug information for Venatus' }
            )
            .setFooter({ text: 'Data from Volvie\'s Spreadsheet' });

        message.channel.send({ embeds: [embed] });
    }

    else if (command === 'update') {
        // Simple admin check (you might want to implement proper permissions)
        if (!message.member.permissions.has('Administrator')) {
            return message.channel.send('You do not have permission to use this command.');
        }

        const success = await fetchBossData();
        if (success) {
            message.channel.send('Boss data has been updated successfully!');
        } else {
            message.channel.send('Failed to update boss data. Please try again later.');
        }
    }

    else if (command === 'debug') {
        // Debug command to show Venatus information
        const venatus = bossData.find(b => b.name === 'Venatus');
        if (venatus) {
            const timeRemaining = getTimeRemaining(venatus);
            const parsedDate = parseCustomDateTime(venatus.respawnTime);
            const extractedTime = extractTimeFromNote(venatus.note);

            const embed = new EmbedBuilder()
                .setTitle('Debug: Venatus')
                .setColor('#58a6ff')
                .addFields(
                    { name: 'Respawn Time', value: venatus.respawnTime || 'N/A' },
                    { name: 'Parsed Date', value: parsedDate ? parsedDate.toString() : 'Invalid' },
                    { name: 'Last Killed', value: venatus.lastKilled || 'N/A' },
                    { name: 'Cooldown', value: venatus.cooldown || 'N/A' },
                    { name: 'Note', value: venatus.note || 'N/A' },
                    { name: 'Extracted from Note', value: extractedTime ? `${extractedTime.text} (${extractedTime.totalMs}ms)` : 'None' },
                    { name: 'Calculated Time', value: `${timeRemaining.text} (${timeRemaining.totalMs}ms)` },
                    { name: 'Class', value: timeRemaining.class }
                )
                .setFooter({ text: `Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}` });

            message.channel.send({ embeds: [embed] });
        } else {
            message.channel.send('Venatus not found in boss data');
        }
    }

    else if (command === 'allbosses') {
        // Show all upcoming bosses with their time remaining for debugging
        const upcomingBosses = [];

        bossData.forEach(boss => {
            if (boss.type === 'fixed') return;

            const timeRemaining = getTimeRemaining(boss);
            if (timeRemaining.class !== 'ready' && timeRemaining.class !== 'fixed' && timeRemaining.totalMs !== null) {
                upcomingBosses.push({
                    boss,
                    timeRemaining: timeRemaining.totalMs,
                    displayText: timeRemaining.text
                });
            }
        });

        // Sort by time remaining (ascending - smallest time first)
        upcomingBosses.sort((a, b) => a.timeRemaining - b.timeRemaining);

        if (upcomingBosses.length === 0) {
            return message.channel.send('No upcoming bosses found.');
        }

        const embed = new EmbedBuilder()
            .setTitle('All Upcoming Bosses (Sorted)')
            .setColor('#58a6ff')
            .setDescription(`All bosses with their respawn times:`)
            .setFooter({ text: `Last updated: ${lastUpdated ? lastUpdated.toLocaleString() : 'Never'}` });

        upcomingBosses.forEach(({ boss, displayText }) => {
            embed.addFields(
                { name: boss.name, value: `${boss.map} (Level ${boss.level})\nTime: ${displayText}`, inline: false }
            );
        });

        message.channel.send({ embeds: [embed] });
    }
});

// Bot ready event
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Initial data fetch
    fetchBossData();

    // Set up periodic data refresh (every 2 minutes)
    setInterval(fetchBossData, 2 * 60 * 1000);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN);
