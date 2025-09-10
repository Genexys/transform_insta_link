import express from 'express';
import { YtDlp } from 'ytdlp-nodejs';

const app = express();
const port = process.env.PORT || 3000;
const ytdlp = new YtDlp();

app.get('/yt/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    // Получение информации о видео с помощью ytdlp-nodejs
    const info = await ytdlp.getInfoAsync(
      `https://www.youtube.com/watch?v=${videoId}`
    );

    // Поиск прямой ссылки на видеофайл. yt-dlp предоставляет более гибкие данные.
    // Возможно, вам придется выбрать нужный формат (например, mp4)
    if ('formats' in info) {
      const videoFormat = info.formats.find(
        format => format.ext === 'mp4' && (format.height ?? 0) <= 720
      );
      const videoUrl = videoFormat ? videoFormat.url : null;

      if (!videoUrl) {
        return res.status(404).send('No suitable video format found');
      }

      // Формируем HTML с мета-тегами для Discord и Telegram
      const html = `
                <!DOCTYPE html>
                <html lang="ru">
                <head>
                    <meta charset="UTF-8">
                    <title>${info.title}</title>
                    <meta property="og:site_name" content="Shorts Previewer">
                    <meta property="og:title" content="${info.title}">
                    <meta property="og:description" content="${info.description}">
                    <meta property="og:image" content="${info.thumbnail}">
                    <meta property="og:type" content="video.other">
                    <meta property="og:url" content="https://www.youtube.com/watch?v=${videoId}">
                    <meta property="og:video:url" content="${videoUrl}">
                    <meta property="og:video:secure_url" content="${videoUrl}">
                    <meta property="og:video:type" content="video/mp4">
                    <meta property="og:video:width" content="${videoFormat?.width}">
                    <meta property="og:video:height" content="${videoFormat?.height}">
                </head>
                <body>
                    <p>Перенаправление...</p>
                </body>
                </html>
            `;

      res.send(html);
    } else {
      return res.status(400).send('Invalid video information');
    }
  } catch (error) {
    console.error('Error fetching video info:', error);
    res.status(500).send('Something went wrong');
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
