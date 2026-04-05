const { MongoClient } = require('mongodb');
const { generateRankCard, generateLeaderboardCard } = require('./rankCard');
const https = require('https');
const tls = require('tls');

const defaultOptions = {
  dbName: 'discord-leveling',
  collectionName: 'levels',
  settingsCollectionName: 'leveling_settings',
};

class MongoPermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MongoPermissionError';
  }
}

class LevelingClient {
  constructor(mongoUri, options = {}) {
    if (!mongoUri) throw new Error('MongoDB URI is required');
    this.mongoUri = mongoUri;
    this.options = { ...defaultOptions, ...options };
    const tlsOptions = {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    };
    
    this.client = new MongoClient(this.mongoUri, {
      ssl: true,
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
      retryWrites: true,
      tlsCAFile: undefined,
      serverSelectionTimeoutMS: 20000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 20000,
      maxPoolSize: 10,
      minPoolSize: 5,
      checkServerIdentity: undefined,
    });
    this.db = null;
    this.rewards = new Map();
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.options.dbName);

    try {
      await this._collection().createIndex({ guildId: 1, userId: 1 }, { unique: true });
      await this._settingsCollection().createIndex({ guildId: 1 }, { unique: true });
    } catch (error) {
      if (error?.codeName === 'AtlasError' || error?.errmsg?.includes('createIndex')) {
        console.warn('⚠️ لم يتم إنشاء الفهرس على MongoDB بسبب صلاحية محدودة. التطبيق سيستمر بدون الفهرس.');
      } else {
        throw error;
      }
    }
  }

  async disconnect() {
    if (!this.client) return;
    await this.client.close();
    this.db = null;
  }

  _collection() {
    if (!this.db) throw new Error('LevelingClient is not connected');
    return this.db.collection(this.options.collectionName);
  }

  _settingsCollection() {
    if (!this.db) throw new Error('LevelingClient is not connected');
    return this.db.collection(this.options.settingsCollectionName);
  }

  _isMongoPermissionError(error) {
    const message = String(error?.errmsg || error?.message || '');
    return /not allowed to do action|not authorized|permission denied/i.test(message);
  }

  _calculateLevel(totalXP) {
    let level = 0;
    let xpForNext = 200;  // زادت من 100 إلى 200
    let remaining = totalXP;

    while (remaining >= xpForNext) {
      remaining -= xpForNext;
      level += 1;
      xpForNext = 200 + level * 100;  // زادت من 100 + level * 50
    }

    return {
      level,
      currentXP: remaining,
      neededXP: xpForNext,
      totalXP,
    };
  }

  _totalXPFromLevel(level) {
    // حساب إجمالي XP المطلوب للوصول إلى مستوى معين
    let total = 0;
    for (let i = 1; i <= level; i++) {
      total += 200 + (i - 1) * 100;
    }
    return total;
  }

  async _ensureUser(guildId, userId) {
    try {
      const result = await this._collection().findOneAndUpdate(
        { guildId, userId },
        { $setOnInsert: { guildId, userId, totalXP: 0, level: 0, messageXP: 0, voiceXP: 0, lastUpdated: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );
      const user = result.value || result;
      if (!user) throw new Error('Failed to ensure user');

      const fixedFields = {};
      if (typeof user.messageXP !== 'number') fixedFields.messageXP = 0;
      if (typeof user.voiceXP !== 'number') fixedFields.voiceXP = 0;
      if (typeof user.totalXP !== 'number') fixedFields.totalXP = (user.messageXP || 0) + (user.voiceXP || 0);
      if (Object.keys(fixedFields).length > 0) {
        await this._collection().updateOne({ guildId, userId }, { $set: fixedFields });
        Object.assign(user, fixedFields);
      }

      return user;
    } catch (error) {
      if (this._isMongoPermissionError(error)) {
        throw new MongoPermissionError('MongoDB permission denied: يفشل الوصول إلى المستندات. تحقق من صلاحيات المستخدم على قاعدة البيانات.');
      }
      throw error;
    }
  }

  addReward(guildId, level, roleId) {
    if (!this.rewards.has(guildId)) {
      this.rewards.set(guildId, new Map());
    }
    this.rewards.get(guildId).set(level, roleId);
    return this;
  }

  async addXP(guildId, userId, amount) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('XP amount must be a positive number');
    }

    const user = await this._ensureUser(guildId, userId);
    const messageXP = Math.max(0, (user.messageXP || 0) + amount);
    const voiceXP = user.voiceXP || 0;
    const totalXP = messageXP + voiceXP;
    const oldLevel = user.level;
    const levelInfo = this._calculateLevel(totalXP);
    const leveledUp = levelInfo.level > oldLevel;
    const rolesEarned = this._collectRewards(guildId, oldLevel, levelInfo.level);

    await this._collection().updateOne(
      { guildId, userId },
      { $set: { totalXP, level: levelInfo.level, messageXP, voiceXP, lastUpdated: new Date() } }
    );

    return {
      ...levelInfo,
      oldLevel,
      newLevel: levelInfo.level,
      leveledUp,
      rolesEarned,
      messageXP,
      voiceXP,
    };
  }

  async addVoiceXP(guildId, userId, amount) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('Voice XP amount must be a positive number');
    }

    const user = await this._ensureUser(guildId, userId);
    const voiceXP = Math.max(0, (user.voiceXP || 0) + amount);
    const messageXP = user.messageXP || 0;
    const totalXP = messageXP + voiceXP;
    const oldLevel = user.level;
    const levelInfo = this._calculateLevel(totalXP);
    const leveledUp = levelInfo.level > oldLevel;
    const rolesEarned = this._collectRewards(guildId, oldLevel, levelInfo.level);

    await this._collection().updateOne(
      { guildId, userId },
      { $set: { totalXP, level: levelInfo.level, messageXP, voiceXP, lastUpdated: new Date() } }
    );

    return {
      ...levelInfo,
      oldLevel,
      newLevel: levelInfo.level,
      leveledUp,
      rolesEarned,
      messageXP,
      voiceXP,
    };
  }

  async setLevel(guildId, userId, level) {
    if (typeof level !== 'number' || level < 0) {
      throw new Error('Level must be a non-negative number');
    }

    const user = await this._ensureUser(guildId, userId);
    const totalXP = this._totalXPFromLevel(level);
    const voiceXP = user.voiceXP || 0;
    const messageXP = Math.max(0, totalXP - voiceXP);

    await this._collection().updateOne(
      { guildId, userId },
      { $set: { totalXP, level, messageXP, voiceXP, lastUpdated: new Date() } },
      { upsert: true }
    );

    return { guildId, userId, level, totalXP, messageXP, voiceXP };
  }

  async removeXP(guildId, userId, amount) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    const user = await this._ensureUser(guildId, userId);
    let messageXP = user.messageXP || 0;
    let voiceXP = user.voiceXP || 0;
    let remaining = amount;

    if (remaining <= messageXP) {
      messageXP -= remaining;
      remaining = 0;
    } else {
      remaining -= messageXP;
      messageXP = 0;
      voiceXP = Math.max(0, voiceXP - remaining);
    }

    const totalXP = Math.max(0, messageXP + voiceXP);
    const levelInfo = this._calculateLevel(totalXP);

    await this._collection().updateOne(
      { guildId, userId },
      { $set: { totalXP, level: levelInfo.level, messageXP, voiceXP, lastUpdated: new Date() } }
    );

    return { guildId, userId, xpRemoved: Math.min(amount, user.totalXP), ...levelInfo, messageXP, voiceXP };
  }

  async resetUser(guildId, userId) {
    await this._collection().updateOne(
      { guildId, userId },
      { $set: { totalXP: 0, level: 0, messageXP: 0, voiceXP: 0, lastUpdated: new Date() } },
      { upsert: true }
    );
    return { guildId, userId, level: 0, totalXP: 0, messageXP: 0, voiceXP: 0 };
  }

  async setAnnouncementChannel(guildId, channelId) {
    await this._settingsCollection().updateOne(
      { guildId },
      { $set: { guildId, announcementChannelId: channelId, updatedAt: new Date() } },
      { upsert: true }
    );
    return { guildId, announcementChannelId: channelId };
  }

  async getAnnouncementChannel(guildId) {
    const setting = await this._settingsCollection().findOne({ guildId });
    return setting?.announcementChannelId || null;
  }

  async clearAnnouncementChannel(guildId) {
    await this._settingsCollection().deleteOne({ guildId });
    return { guildId, announcementChannelId: null };
  }

  async getLeaderboard(guildId, options = {}) {
    const limit = Math.max(1, Math.min(100, options.limit ?? 10));
    const page = Math.max(1, options.page ?? 1);
    const skip = (page - 1) * limit;

    const total = await this._collection().countDocuments({ guildId });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const entries = await this._collection()
      .find({ guildId })
      .sort({ totalXP: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return {
      guildId,
      page,
      totalPages,
      totalEntries: total,
      entries: entries.map((entry, index) => ({
        rank: skip + index + 1,
        userId: entry.userId,
        level: entry.level,
        totalXP: entry.totalXP,
        messageXP: entry.messageXP || 0,
        voiceXP: entry.voiceXP || 0,
      })),
    };
  }

  async getUserRank(guildId, userId) {
    const user = await this._ensureUser(guildId, userId);
    const rank = await this._collection().countDocuments({ guildId, totalXP: { $gt: user.totalXP } }) + 1;
    return { ...user, rank };
  }

  async generateRankCard(guildId, userId, options = {}) {
    const user = await this._ensureUser(guildId, userId);
    const levelInfo = this._calculateLevel(user.totalXP);
    const theme = this._pickTheme(levelInfo.level);

    return generateRankCard({
      username: options.username || 'Unknown',
      discriminator: options.discriminator || '0000',
      avatarURL: options.avatarURL || null,
      level: levelInfo.level,
      currentXP: levelInfo.currentXP,
      neededXP: levelInfo.neededXP,
      totalXP: user.totalXP,
      messageXP: user.messageXP || 0,
      voiceXP: user.voiceXP || 0,
      rank: options.rank ?? null,
      theme,
    });
  }

  async generateLeaderboardImage(guildId, options = {}, usernames = {}, highlightUserId = null) {
    const limit = Math.max(1, Math.min(10, options.limit ?? 10));
    const page = Math.max(1, options.page ?? 1);
    const lb = await this.getLeaderboard(guildId, { limit, page });
    
    const entriesWithThemes = lb.entries.map(entry => ({
      ...entry,
      theme: this._pickTheme(entry.level)
    }));
    
    return generateLeaderboardCard(entriesWithThemes, lb.page, lb.totalPages, usernames, highlightUserId);
  }

  _pickTheme(level) {
    // 100 مستوى مختلف مع ألوان فريدة
    const themes = [
      // 1-10: معادن أساسية
      { name: 'Iron I', accent: '#a9a9a9', background: '#1a1a1a', fill: '#e8e8e8' },
      { name: 'Iron II', accent: '#b0b0b0', background: '#1e1e1e', fill: '#ebebeb' },
      { name: 'Iron III', accent: '#b7b7b7', background: '#222222', fill: '#eeeeee' },
      { name: 'Bronze I', accent: '#b76e30', background: '#1f1710', fill: '#ffd7b2' },
      { name: 'Bronze II', accent: '#c27a3a', background: '#211709', fill: '#ffdfc5' },
      { name: 'Bronze III', accent: '#cd8644', background: '#231c0d', fill: '#ffe7d8' },
      { name: 'Silver I', accent: '#c0c0c0', background: '#1f2126', fill: '#f4f4f4' },
      { name: 'Silver II', accent: '#d3d3d3', background: '#232729', fill: '#f8f8f8' },
      { name: 'Silver III', accent: '#e5e5e5', background: '#27292d', fill: '#fcfcfc' },
      { name: 'Gold I', accent: '#ffd700', background: '#2a220b', fill: '#fff5b1' },
      
      // 11-20: معادن نبيلة
      { name: 'Gold II', accent: '#ffed4e', background: '#2d2710', fill: '#fffad5' },
      { name: 'Gold III', accent: '#fff44f', background: '#302c15', fill: '#fffedf' },
      { name: 'Platinum I', accent: '#e5e4e2', background: '#202022', fill: '#fafaf9' },
      { name: 'Platinum II', accent: '#f0e6d2', background: '#252527', fill: '#fdfbf7' },
      { name: 'Diamond I', accent: '#b9f2f6', background: '#0e1819', fill: '#e5f9fa' },
      { name: 'Diamond II', accent: '#92e3ef', background: '#101b1d', fill: '#d8f4f8' },
      { name: 'Diamond III', accent: '#6bdfe8', background: '#122529', fill: '#cbeff5' },
      { name: 'Sapphire I', accent: '#3d7bce', background: '#0c1731', fill: '#d8e7ff' },
      { name: 'Sapphire II', accent: '#4a8ae8', background: '#0d1a37', fill: '#e0efff' },
      { name: 'Sapphire III', accent: '#5799ff', background: '#0e1f3d', fill: '#e8f5ff' },
      
      // 21-30: أحجار كريمة
      { name: 'Emerald I', accent: '#2ecc71', background: '#0d2718', fill: '#d8f3df' },
      { name: 'Emerald II', accent: '#40e080', background: '#0f2f1f', fill: '#e5f7eb' },
      { name: 'Emerald III', accent: '#52f08f', background: '#113827', fill: '#f0faf4' },
      { name: 'Ruby I', accent: '#e74c3c', background: '#2c1111', fill: '#ffd6d3' },
      { name: 'Ruby II', accent: '#f65649', background: '#341515', fill: '#ffe0df' },
      { name: 'Ruby III', accent: '#ff6656', background: '#3c191a', fill: '#ffccca' },
      { name: 'Amethyst I', accent: '#9b59b6', background: '#22132a', fill: '#eed6ff' },
      { name: 'Amethyst II', accent: '#ab6bc8', background: '#261638', fill: '#f5e5ff' },
      { name: 'Amethyst III', accent: '#bb7dda', background: '#2a1942', fill: '#fcf0ff' },
      { name: 'Topaz I', accent: '#f39c12', background: '#2a1f05', fill: '#ffedc9' },
      
      // 31-40: أحجار متألقة
      { name: 'Topaz II', accent: '#f8ac1a', background: '#2e2208', fill: '#fff4d9' },
      { name: 'Topaz III', accent: '#ffb922', background: '#332608', fill: '#fffdea' },
      { name: 'Opal I', accent: '#ff6b9d', background: '#2c1620', fill: '#ffe5f0' },
      { name: 'Opal II', accent: '#ff8ab5', background: '#321a2b', fill: '#ffeef7' },
      { name: 'Opal III', accent: '#ffa5cd', background: '#3d1e38', fill: '#fff7fd' },
      { name: 'Jade I', accent: '#00a86b', background: '#0f2d1e', fill: '#ccf9e8' },
      { name: 'Jade II', accent: '#20c997', background: '#12362a', fill: '#d9fef4' },
      { name: 'Jade III', accent: '#40e0a6', background: '#153f36', fill: '#e6fef9' },
      { name: 'Moonstone I', accent: '#b9f2f6', background: '#0e1819', fill: '#e5f9fa' },
      { name: 'Moonstone II', accent: '#d4f5fe', background: '#0f1f23', fill: '#effdff' },
      
      // 41-50: الأحجار النادرة
      { name: 'Moonstone III', accent: '#eefbff', background: '#132a2f', fill: '#f9feff' },
      { name: 'Sunstone I', accent: '#ffa500', background: '#2a1f00', fill: '#fff4d1' },
      { name: 'Sunstone II', accent: '#ffb533', background: '#2d2408', fill: '#fff9e6' },
      { name: 'Sunstone III', accent: '#ffc560', background: '#332d10', fill: '#fffeeb' },
      { name: 'Starlight I', accent: '#e8e8ff', background: '#1a1a2e', fill: '#f5f5ff' },
      { name: 'Starlight II', accent: '#f0f0ff', background: '#202033', fill: '#fafaff' },
      { name: 'Nebula I', accent: '#8b7fff', background: '#17121f', fill: '#e5deff' },
      { name: 'Nebula II', accent: '#a99fff', background: '#1f1829', fill: '#f0ebff' },
      { name: 'Cosmic I', accent: '#5a4cff', background: '#120f24', fill: '#d7d5ff' },
      { name: 'Cosmic II', accent: '#7a6aff', background: '#19152b', fill: '#e5e0ff' },
      
      // 51-60: السماوية
      { name: 'Cosmic III', accent: '#9a8aff', background: '#201b33', fill: '#f0ecff' },
      { name: 'Aurora I', accent: '#00ffcc', background: '#001a16', fill: '#ccffef' },
      { name: 'Aurora II', accent: '#33ffdd', background: '#0a1f19', fill: '#d9ffed' },
      { name: 'Aurora III', accent: '#66ffee', background: '#0d2822', fill: '#e6fff6' },
      { name: 'Twilight I', accent: '#6b46c1', background: '#1f0f33', fill: '#dcc7ff' },
      { name: 'Twilight II', accent: '#8b5cf6', background: '#241644', fill: '#e8d7ff' },
      { name: 'Twilight III', accent: '#a78bfa', background: '#2a1b4f', fill: '#f0e5ff' },
      { name: 'Phoenix I', accent: '#ff4500', background: '#2b1400', fill: '#ffb399' },
      { name: 'Phoenix II', accent: '#ff6b35', background: '#321905', fill: '#ffd4b3' },
      { name: 'Phoenix III', accent: '#ff8c42', background: '#3d2410', fill: '#ffe5cc' },
      
      // 61-70: الأسطوري
      { name: 'Dragon I', accent: '#ff1493', background: '#3d0015', fill: '#ff99d0' },
      { name: 'Dragon II', accent: '#ff4db8', background: '#450020', fill: '#ff99d0' },
      { name: 'Dragon III', accent: '#ff66cc', background: '#4d0027', fill: '#ffb3e0' },
      { name: 'Griffin I', accent: '#daa520', background: '#2d1b00', fill: '#ffe8a6' },
      { name: 'Griffin II', accent: '#efb947', background: '#332000', fill: '#fff0bf' },
      { name: 'Griffin III', accent: '#ffd700', background: '#3d2609', fill: '#fff7d9' },
      { name: 'Kraken I', accent: '#00ced1', background: '#001f1f', fill: '#ccf7f7' },
      { name: 'Kraken II', accent: '#40e0e6', background: '#0a2828', fill: '#d9f5f5' },
      { name: 'Kraken III', accent: '#7ffef0', background: '#0d3333', fill: '#e6fffe' },
      { name: 'Phoenix Ascended', accent: '#ff00ff', background: '#200020', fill: '#ff99ff' },
      
      // 71-80: الإلهي
      { name: 'Divine I', accent: '#ffff00', background: '#2d2d00', fill: '#ffffe6' },
      { name: 'Divine II', accent: '#ffff33', background: '#3d3d00', fill: '#fffef0' },
      { name: 'Divine III', accent: '#ffff66', background: '#4d4d00', fill: '#ffffeb' },
      { name: 'Celestial I', accent: '#ff69b4', background: '#2d1a24', fill: '#ffc9e0' },
      { name: 'Celestial II', accent: '#ff85c0', background: '#361f2b', fill: '#ffd9eb' },
      { name: 'Celestial III', accent: '#ffa1d0', background: '#3f2437', fill: '#ffe8f5' },
      { name: 'Ethereal I', accent: '#c8a2c8', background: '#2a1a2a', fill: '#e8d9e8' },
      { name: 'Ethereal II', accent: '#dab3da', background: '#331f33', fill: '#f0e5f0' },
      { name: 'Ethereal III', accent: '#ecc4ec', background: '#3c2b3c', fill: '#f8f2f8' },
      { name: 'Ascendant I', accent: '#00ff00', background: '#001f00', fill: '#ccffcc' },
      
      // 81-90: الأعظم
      { name: 'Ascendant II', accent: '#33ff33', background: '#0a2609', fill: '#d9ffd9' },
      { name: 'Ascendant III', accent: '#66ff66', background: '#0d3d0d', fill: '#e6ffe6' },
      { name: 'Mythic I', accent: '#ff00ff', background: '#2d002d', fill: '#ff99ff' },
      { name: 'Mythic II', accent: '#ff33ff', background: '#3d0a3d', fill: '#ffb3ff' },
      { name: 'Mythic III', accent: '#ff66ff', background: '#4d0d4d', fill: '#e6ffe6' },
      { name: 'Immortal I', accent: '#00ffff', background: '#001f2d', fill: '#ccf7ff' },
      { name: 'Immortal II', accent: '#33ffff', background: '#0a3d4d', fill: '#d9feff' },
      { name: 'Immortal III', accent: '#66ffff', background: '#0d5c6b', fill: '#e6ffff' },
      { name: 'Omega I', accent: '#ffaa00', background: '#2d1a00', fill: '#ffd9a6' },
      { name: 'Omega II', accent: '#ffbb33', background: '#3d2208', fill: '#ffe6bf' },
      
      // 91-100: الأسطوري الأقصى
      { name: 'Omega III', accent: '#ffcc66', background: '#4d2d0d', fill: '#fff0d9' },
      { name: 'Infinite I', accent: '#ff0000', background: '#2d0000', fill: '#ff9999' },
      { name: 'Infinite II', accent: '#ff3333', background: '#3d0a0a', fill: '#ffb3b3' },
      { name: 'Infinite III', accent: '#ff6666', background: '#4d0d0d', fill: '#ffcccc' },
      { name: 'Supreme I', accent: '#8B00FF', background: '#2d0033', fill: '#d699ff' },
      { name: 'Supreme II', accent: '#9933ff', background: '#3d0a4d', fill: '#e0b3ff' },
      { name: 'Supreme III', accent: '#bb66ff', background: '#4d0d66', fill: '#e8ccff' },
      { name: 'Ultimate I', accent: '#ff0080', background: '#2d001a', fill: '#ff99cc' },
      { name: 'Ultimate II', accent: '#ff3399', background: '#3d0a26', fill: '#ffb3d9' },
      { name: 'Ultimate III', accent: '#ff66b2', background: '#4d0d33', fill: '#ffccdb' },
      { name: 'Transcendent', accent: '#ffffff', background: '#000000', fill: '#ffffff' }
    ];
    
    // الحد الأقصى 100 مستوى
    const levelIndex = Math.min(Math.max(level - 1, 0), 99);
    return themes[levelIndex] || themes[99];
  }

  _collectRewards(guildId, oldLevel, newLevel) {
    const guildRewards = this.rewards.get(guildId);
    if (!guildRewards) return [];
    return Array.from(guildRewards.entries())
      .filter(([level]) => level > oldLevel && level <= newLevel)
      .map(([, roleId]) => roleId);
  }
}

module.exports = { LevelingClient };
