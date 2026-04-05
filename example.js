const { Client, GatewayIntentBits, Events, REST, Routes, AttachmentBuilder, PermissionsBitField } = require('discord.js');
const { LevelingClient } = require('./index');
require('dotenv').config();

// ── الإعدادات ──────────────────────────────────────────────────────────────

const BOT_TOKEN   = process.env.BOT_TOKEN   || 'YOUR_BOT_TOKEN';       // توكن البوت
const CLIENT_ID   = process.env.CLIENT_ID   || 'YOUR_CLIENT_ID';       // ID التطبيق
const MONGO_URI   = process.env.MONGO_URI   || 'YOUR_MONGODB_URI';     // رابط MongoDB Atlas
const DB_NAME     = process.env.DB_NAME     || 'YOUR_DB_NAME';         // اسم قاعدة البيانات

if ([BOT_TOKEN, CLIENT_ID, MONGO_URI, DB_NAME].some(v => v.startsWith('YOUR_'))) {
  console.error('خطأ: يجب ضبط BOT_TOKEN و CLIENT_ID و MONGO_URI و DB_NAME في متغيرات البيئة.');
  process.exit(1);
}

// ── إنشاء الكلاينت ──────────────────────────────────────────────────────────

const leveling = new LevelingClient(MONGO_URI, { dbName: DB_NAME });

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

bot.on('error', (error) => {
  console.error('Discord client error:', error);
});

// ── Slash Commands تعريف ─────────────────────────────────────────────────────

const commands = [
  {
    name: 'rank',
    description: 'شوف رانك مستخدم',
    options: [{
      name: 'user', type: 6, description: 'المستخدم', required: false
    }]
  },
  {
    name: 'leaderboard',
    description: 'أفضل اللاعبين في السيرفر',
    options: [
      { name: 'user', type: 6, description: 'المستخدم لعرض صفه', required: false },
      { name: 'page', type: 4, description: 'رقم الصفحة', required: false }
    ]
  },
  {
    name: 'setannouncechannel',
    description: 'حدد قناة لإرسال رسالة مستوى جديد',
    options: [
      { name: 'channel', type: 7, description: 'القناة', required: true }
    ]
  },
  {
    name: 'setlevel',
    description: 'عيّن لفل لمستخدم (أدمن)',
    options: [
      { name: 'user',  type: 6, description: 'المستخدم', required: true },
      { name: 'level', type: 4, description: 'اللفل',     required: true },
    ]
  },
  {
    name: 'addxp',
    description: 'أضف XP لمستخدم (أدمن)',
    options: [
      { name: 'user',   type: 6, description: 'المستخدم', required: true },
      { name: 'amount', type: 4, description: 'الكمية',    required: true },
    ]
  },
  {
    name: 'removexp',
    description: 'احذف XP من مستخدم (أدمن)',
    options: [
      { name: 'user',   type: 6, description: 'المستخدم', required: true },
      { name: 'amount', type: 4, description: 'الكمية',    required: true },
    ]
  },
  {
    name: 'resetuser',
    description: 'ريست مستخدم (أدمن)',
    options: [{
      name: 'user', type: 6, description: 'المستخدم', required: true
    }]
  },
  {
    name: 'top',
    description: 'أعلى اللاعبين في السيرفر',
    options: [
      { name: 'count', type: 4, description: 'عدد اللاعبين', required: false }
    ]
  },
];

// ── تشغيل البوت ──────────────────────────────────────────────────────────────

(async () => {
  await leveling.connect();
  console.log('✅ MongoDB connected');

  const rest = new REST().setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('✅ Slash commands registered');

  // إضافة Role Rewards (عدّل الـ IDs حسب سيرفرك)
  // leveling.addReward('GUILD_ID', 5,  'ROLE_ID_LEVEL_5');
  // leveling.addReward('GUILD_ID', 10, 'ROLE_ID_LEVEL_10');
  // leveling.addReward('GUILD_ID', 20, 'ROLE_ID_LEVEL_20');

  await bot.login(BOT_TOKEN);
})();

const cooldowns = new Map();
const dbErrorCooldowns = new Map();
const voiceJoinTimestamps = new Map();

function handleDbErrorNotification(channel, guildId) {
  const lastNotified = dbErrorCooldowns.get(guildId) ?? 0;
  if (Date.now() - lastNotified < 300_000) return;
  dbErrorCooldowns.set(guildId, Date.now());
  channel.send('❌ حدث خطأ في قاعدة البيانات. الرجاء إعلام المسؤول أو التحقق من صلاحيات MongoDB.').catch(console.error);
}

async function sendLevelUpAnnouncement(guild, userId, result, fallbackChannel = null) {
  const announceChannelId = await leveling.getAnnouncementChannel(guild.id);
  const targetUser = await guild.client.users.fetch(userId).catch(() => null);
  const userRank = await leveling.getUserRank(guild.id, userId).catch(() => null);
  const buffer = await leveling.generateRankCard(guild.id, userId, {
    username: targetUser?.username || 'Unknown',
    discriminator: targetUser?.discriminator || '0000',
    avatarURL: targetUser?.displayAvatarURL({ extension: 'png' }) || null,
    rank: userRank?.rank ?? null,
  });
  const attachment = new AttachmentBuilder(buffer, { name: 'levelup.png' });
  const content = `<@${userId}> 🎉 وصل لـ **Level ${result.newLevel}**!`;

  let channel = null;
  if (announceChannelId) {
    channel = guild.channels.cache.get(announceChannelId) || await guild.channels.fetch(announceChannelId).catch(() => null);
  }
  if (!channel) channel = fallbackChannel;
  if (!channel || !channel.send) return;

  await channel.send({ content, files: [attachment] }).catch(console.error);
}

bot.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.member?.user.bot) return;
  const userId = newState.id;
  const guildId = newState.guild?.id;
  if (!guildId) return;

  const key = `${guildId}:${userId}`;
  const now = Date.now();

  if (!oldState.channelId && newState.channelId) {
    voiceJoinTimestamps.set(key, now);
    return;
  }

  if (oldState.channelId && !newState.channelId) {
    const joinedAt = voiceJoinTimestamps.get(key) ?? now;
    voiceJoinTimestamps.delete(key);
    const durationSeconds = Math.floor((now - joinedAt) / 1000);
    const minutes = Math.floor(durationSeconds / 60);
    if (minutes < 1) return;

    const xp = minutes * 10;
    try {
      const result = await leveling.addVoiceXP(guildId, userId, xp);
      if (result.leveledUp) {
        const guild = newState.guild;
        await sendLevelUpAnnouncement(guild, userId, result);
      }
    } catch (error) {
      console.error('VoiceStateUpdate XP error:', error);
    }
    return;
  }

  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    const joinedAt = voiceJoinTimestamps.get(key) ?? now;
    const durationSeconds = Math.floor((now - joinedAt) / 1000);
    const minutes = Math.floor(durationSeconds / 60);
    voiceJoinTimestamps.set(key, now);
    if (minutes < 1) return;

    const xp = minutes * 10;
    try {
      const result = await leveling.addVoiceXP(guildId, userId, xp);
      if (result.leveledUp) {
        const guild = newState.guild;
        await sendLevelUpAnnouncement(guild, userId, result);
      }
    } catch (error) {
      console.error('VoiceStateUpdate XP error:', error);
    }
  }
});

bot.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const lower = content.toLowerCase();
  const guild = message.guild;

  if (lower === 'توب' || lower === 'top') {
    const lb = await leveling.getLeaderboard(guild.id, { limit: 5, page: 1 });
    const usernames = {};
    for (const entry of lb.entries) {
      try {
        const discordUser = await guild.client.users.fetch(entry.userId);
        usernames[entry.userId] = discordUser.username;
      } catch (err) {
        usernames[entry.userId] = `User ${entry.userId.slice(-4)}`;
      }
    }

    const buffer = await leveling.generateLeaderboardImage(guild.id, { limit: 5, page: 1 }, usernames);
    const attachment = new AttachmentBuilder(buffer, { name: 'top.png' });
    await message.channel.send({ files: [attachment] }).catch(console.error);
    return;
  }

  if (lower.startsWith('رانك') || lower.startsWith('rank')) {
    const target = message.mentions.users.first() || message.author;
    const userRank = await leveling.getUserRank(guild.id, target.id);
    const buffer = await leveling.generateRankCard(guild.id, target.id, {
      username:      target.username,
      discriminator: target.discriminator,
      avatarURL:     target.displayAvatarURL({ extension: 'png' }),
      rank:          userRank.rank,
    });
    const attachment = new AttachmentBuilder(buffer, { name: 'rank.png' });
    await message.channel.send({ files: [attachment] }).catch(console.error);
    return;
  }

  const key = `${message.guild.id}:${message.author.id}`;
  const last = cooldowns.get(key) ?? 0;
  if (Date.now() - last < 60_000) return;
  cooldowns.set(key, Date.now());

  try {
    const xp = Math.floor(Math.random() * 11) + 15;
    const result = await leveling.addXP(message.guild.id, message.author.id, xp);

    if (result.leveledUp) {
      await sendLevelUpAnnouncement(message.guild, message.author.id, result, message.channel);

      if (result.rolesEarned.length > 0) {
        const member = await message.guild.members.fetch(message.author.id);
        for (const roleId of result.rolesEarned) {
          await member.roles.add(roleId).catch(console.error);
        }
        await message.channel.send(`🏅 <@${message.author.id}> حصل على رول جديد!`);
      }
    }
  } catch (error) {
    console.error('MessageCreate error:', error);
    if (error.message?.includes('MongoDB permission denied')) {
      handleDbErrorNotification(message.channel, message.guild.id);
    }
  }
});

bot.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const { commandName, user, guild } = interaction;

  try {
    if (commandName === 'rank') {
      const target = interaction.options.getUser('user') ?? user;
      const userRank = await leveling.getUserRank(guild.id, target.id);
      const buffer = await leveling.generateRankCard(guild.id, target.id, {
        username:      target.username,
        discriminator: target.discriminator,
        avatarURL:     target.displayAvatarURL({ extension: 'png' }),
        rank:          userRank.rank,
      });
      const attachment = new AttachmentBuilder(buffer, { name: 'rank.png' });
      await interaction.reply({ files: [attachment] });
      return;
    }

    if (commandName === 'leaderboard') {
      const target = interaction.options.getUser('user');
      const pageOption = interaction.options.getInteger('page');
      let page = pageOption ?? 1;
      let highlightUserId = null;

      if (target) {
        const targetRank = await leveling.getUserRank(guild.id, target.id);
        highlightUserId = target.id;
        if (pageOption == null) {
          page = Math.max(1, Math.ceil(targetRank.rank / 10));
        }
      }

      const lb = await leveling.getLeaderboard(guild.id, { limit: 10, page });
      const usernames = {};
      for (const entry of lb.entries) {
        try {
          const discordUser = await guild.client.users.fetch(entry.userId);
          usernames[entry.userId] = discordUser.username;
        } catch (err) {
          usernames[entry.userId] = `User ${entry.userId.slice(-4)}`;
        }
      }

      const buffer = await leveling.generateLeaderboardImage(guild.id, { limit: 10, page }, usernames, highlightUserId);
      const attachment = new AttachmentBuilder(buffer, { name: 'leaderboard.png' });
      await interaction.reply({ files: [attachment] });
      return;
    }

    if (commandName === 'setannouncechannel') {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.editReply({ content: '❌ تحتاج صلاحية إدارة السيرفر لإعداد قناة الإعلانات.' });
        return;
      }

      const channel = interaction.options.getChannel('channel');
      if (!channel || !channel.isTextBased()) {
        await interaction.editReply({ content: '❌ الرجاء اختيار قناة نصية صالحة.' });
        return;
      }

      await leveling.setAnnouncementChannel(guild.id, channel.id);
      await interaction.editReply({ content: `✅ تم تعيين قناة الإعلانات إلى ${channel}` });
      return;
    }

    if (commandName === 'top') {
      const count = Math.max(1, Math.min(10, interaction.options.getInteger('count') ?? 5));
      const lb = await leveling.getLeaderboard(guild.id, { limit: count, page: 1 });
      const usernames = {};
      for (const entry of lb.entries) {
        try {
          const discordUser = await guild.client.users.fetch(entry.userId);
          usernames[entry.userId] = discordUser.username;
        } catch (err) {
          usernames[entry.userId] = `User ${entry.userId.slice(-4)}`;
        }
      }
      const buffer = await leveling.generateLeaderboardImage(guild.id, { limit: count, page: 1 }, usernames);
      const attachment = new AttachmentBuilder(buffer, { name: 'top.png' });
      await interaction.reply({ files: [attachment] });
      return;
    }

    if (commandName === 'setlevel') {
      const target = interaction.options.getUser('user');
      const level  = interaction.options.getInteger('level');
      const result = await leveling.setLevel(guild.id, target.id, level);
      await interaction.reply(`✅ تم تعيين **${target.username}** على Level **${result.level}**`);
      return;
    }

    if (commandName === 'addxp') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const result = await leveling.addXP(guild.id, target.id, amount);
      await interaction.reply(`✅ تمت إضافة **${amount} XP** لـ ${target.username} — الآن Level **${result.level}**`);
      return;
    }

    if (commandName === 'removexp') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const result = await leveling.removeXP(guild.id, target.id, amount);
      await interaction.reply(`✅ تم حذف **${result.xpRemoved} XP** من ${target.username} — الآن Level **${result.level}**`);
      return;
    }

    if (commandName === 'resetuser') {
      const target = interaction.options.getUser('user');
      await leveling.resetUser(guild.id, target.id);
      await interaction.reply(`✅ تم ريست **${target.username}**`);
      return;
    }
  } catch (error) {
    console.error('InteractionCreate error:', error);
    const replyText = error.message?.includes('MongoDB permission denied')
      ? '❌ حدث خطأ في قاعدة البيانات. الرجاء إعلام المسؤول أو التحقق من صلاحيات MongoDB.'
      : '❌ حدث خطأ داخلي أثناء تنفيذ الأمر.';

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: replyText });
      } else {
        await interaction.reply({ content: replyText });
      }
    } catch (replyError) {
      console.error('Failed to send interaction error reply:', replyError);
    }
  }
});

process.on('SIGINT', async () => {
  await leveling.disconnect();
  process.exit(0);
});
