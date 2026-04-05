const { createCanvas, loadImage } = require('@napi-rs/canvas');

const defaultTheme = {
  background: '#101820',
  panel: '#1f2430',
  accent: '#5b8cff',
  fill: '#ffffff',
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

async function generateRankCard(options = {}) {
  const width = 1280;
  const height = 420;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const theme = { ...defaultTheme, ...(options.theme || {}) };

  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, theme.background);
  bgGradient.addColorStop(1, '#070a10');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, 0, width, 12);

  drawRoundedRect(ctx, 28, 18, width - 56, height - 36, 24);
  const panelGradient = ctx.createLinearGradient(28, 18, 28, height - 18);
  panelGradient.addColorStop(0, theme.panel);
  panelGradient.addColorStop(1, '#0c1117');
  ctx.fillStyle = panelGradient;
  ctx.fill();

  const avatarX = 60;
  const avatarY = 70;
  const avatarSize = 220;

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (options.avatarURL) {
    try {
      const avatar = await loadImage(options.avatarURL);
      ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
    } catch (error) {
      ctx.fillStyle = '#181f27';
      ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    }
  } else {
    ctx.fillStyle = '#181f27';
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
  }

  ctx.restore();

  const rightX = avatarX + avatarSize + 40;
  const rightWidth = width - rightX - 60;

  ctx.fillStyle = theme.fill;
  ctx.font = 'bold 54px Sans';
  const title = `${options.username || 'Unknown'}#${options.discriminator || '0000'}`;
  ctx.fillText(title, rightX, 95);

  if (typeof options.rank === 'number') {
    const rankBadgeWidth = 220;
    const rankBadgeHeight = 70;
    ctx.fillStyle = '#0d1524';
    drawRoundedRect(ctx, width - rankBadgeWidth - 50, 50, rankBadgeWidth, rankBadgeHeight, 18);
    ctx.fill();

    ctx.font = 'bold 44px Sans';
    ctx.fillStyle = theme.accent;
    ctx.textAlign = 'right';
    ctx.fillText(`#${options.rank}`, width - 65, 98);
    ctx.textAlign = 'left';
  }

  const statY = 160;
  const statHeight = 90;
  const statWidth = Math.floor((rightWidth - 30) / 4);
  const stats = [
    { label: 'Level', value: `${options.level ?? 0}` },
    { label: 'Total XP', value: `${options.totalXP?.toLocaleString() ?? 0}` },
    { label: 'Chat XP', value: `${options.messageXP?.toLocaleString() ?? 0}` },
    { label: 'Voice XP', value: `${options.voiceXP?.toLocaleString() ?? 0}` },
  ];

  stats.forEach((stat, index) => {
    const statX = rightX + index * (statWidth + 10);
    drawRoundedRect(ctx, statX, statY, statWidth, statHeight, 20);
    ctx.fillStyle = '#111821';
    ctx.fill();

    ctx.fillStyle = '#7f8fa4';
    ctx.font = '500 20px Sans';
    ctx.fillText(stat.label, statX + 20, statY + 34);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px Sans';
    ctx.fillText(stat.value, statX + 20, statY + 70);
  });

  const progressX = rightX;
  const progressY = 290;
  const progressWidth = rightWidth;
  const progressHeight = 42;
  const progressPercent = clamp((options.currentXP ?? 0) / Math.max(options.neededXP || 1, 1), 0, 1);

  drawRoundedRect(ctx, progressX, progressY, progressWidth, progressHeight, 22);
  ctx.fillStyle = '#0d1520';
  ctx.fill();

  drawRoundedRect(ctx, progressX, progressY, progressWidth * progressPercent, progressHeight, 22);
  ctx.fillStyle = theme.accent;
  ctx.fill();

  ctx.font = '500 26px Sans';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`Progress: ${options.currentXP ?? 0} / ${options.neededXP ?? 0} XP`, progressX + 24, progressY + 30);

  const tagX = rightX;
  const tagY = progressY + 70;
  const tagText = `Theme: ${theme.name || 'Default'}`;
  const tagWidth = ctx.measureText(tagText).width + 34;
  drawRoundedRect(ctx, tagX, tagY, tagWidth, 36, 18);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '500 20px Sans';
  ctx.fillText(tagText, tagX + 18, tagY + 25);

  return canvas.toBuffer('image/png');
}

async function generateLeaderboardCard(entries = [], page = 1, totalPages = 1, usernames = {}, highlightUserId = null) {
  const width = 1460;
  const entryHeight = 120;
  const headerHeight = 180;
  const height = headerHeight + entries.length * entryHeight + 80;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const backgroundGradient = ctx.createLinearGradient(0, 0, 0, height);
  backgroundGradient.addColorStop(0, '#08101d');
  backgroundGradient.addColorStop(1, '#0f1726');
  ctx.fillStyle = backgroundGradient;
  ctx.fillRect(0, 0, width, height);

  const headerGradient = ctx.createLinearGradient(30, 30, width - 30, 30);
  headerGradient.addColorStop(0, '#2d3aec');
  headerGradient.addColorStop(1, '#0f1d4d');
  ctx.fillStyle = headerGradient;
  drawRoundedRect(ctx, 30, 30, width - 60, headerHeight, 28);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 72px Sans';
  ctx.fillText('LEADERBOARD', 70, 110);

  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '500 28px Sans';
  ctx.fillText(`Page ${page}/${totalPages}`, width - 320, 90);
  ctx.fillText(`Updated ${new Date().toLocaleTimeString()}`, width - 320, 125);

  entries.forEach((entry, index) => {
    const y = headerHeight + 40 + index * entryHeight;
    const rowHeight = entryHeight - 16;
    const theme = entry.theme || { accent: '#5b8cff', background: '#1d2837', name: 'Default' };
    const isHighlighted = highlightUserId && entry.userId === highlightUserId;

    const rowGradient = ctx.createLinearGradient(30, y, width - 30, y + rowHeight);
    rowGradient.addColorStop(0, isHighlighted ? '#172743' : '#0f1725');
    rowGradient.addColorStop(1, isHighlighted ? '#142243' : '#111b26');
    ctx.fillStyle = rowGradient;
    drawRoundedRect(ctx, 30, y, width - 60, rowHeight, 22);
    ctx.fill();

    if (isHighlighted) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 3;
      drawRoundedRect(ctx, 30, y, width - 60, rowHeight, 22);
      ctx.stroke();
    }

    ctx.fillStyle = theme.accent;
    drawRoundedRect(ctx, 30, y + 18, 10, rowHeight - 36, 10);
    ctx.fill();

    ctx.font = 'bold 44px Sans';
    ctx.fillStyle = '#ffffff';
    const rankText = ['🥇', '🥈', '🥉'][index] || `#${entry.rank}`;
    ctx.fillText(rankText, 60, y + 72);

    const username = usernames[entry.userId] || `User ${entry.userId.slice(-4)}`;
    ctx.font = 'bold 36px Sans';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(username, 150, y + 65);

    ctx.font = '500 24px Sans';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(`Lvl ${entry.level}`, 150, y + 96);

    const xpText = `${entry.totalXP.toLocaleString()} XP`;
    ctx.font = '700 32px Sans';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(xpText, width - 410, y + 70);

    const smallStatWidths = [190, 190, 220];
    const statStartX = width - 410 - smallStatWidths.reduce((acc, cur) => acc + cur + 16, 0);
    const statY = y + 28;
    const stats = [
      { label: 'Total', value: entry.totalXP.toLocaleString() },
      { label: 'Chat', value: entry.messageXP?.toLocaleString() ?? '0' },
      { label: 'Voice', value: entry.voiceXP?.toLocaleString() ?? '0' },
    ];

    let currentX = statStartX;
    stats.forEach((stat, idx) => {
      const widthBox = smallStatWidths[idx];
      drawRoundedRect(ctx, currentX, statY, widthBox, rowHeight - 40, 18);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();

      ctx.fillStyle = '#9bb0d3';
      ctx.font = '500 18px Sans';
      ctx.fillText(stat.label, currentX + 16, statY + 28);

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 26px Sans';
      ctx.fillText(stat.value, currentX + 16, statY + 60);
      currentX += widthBox + 16;
    });

    const themeText = theme.name || 'Default';
    ctx.font = '500 22px Sans';
    const themeWidth = ctx.measureText(themeText).width + 30;
    drawRoundedRect(ctx, width - 310, y + 82, themeWidth, 32, 16);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(themeText, width - 295, y + 104);
  });

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '400 22px Sans';
  ctx.fillText(`Generated: ${new Date().toLocaleTimeString()} • Entries: ${entries.length}`, 50, height - 30);

  return canvas.toBuffer('image/png');
}

module.exports = { generateRankCard, generateLeaderboardCard };
