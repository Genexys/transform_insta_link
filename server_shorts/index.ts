import express from 'express';
import ytdl from 'ytdl-core';

const app = express();
const port = process.env.PORT || 4000;

app.get('/yt/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!ytdl.validateID(videoId)) {
    return res.status(400).send('Invalid video ID');
  }

  try {
    const info = await ytdl.getInfo(videoId);
    const videoUrl = ytdl.chooseFormat(info.formats, { quality: '137' }).url;

    const html = `
            <!DOCTYPE html>
            <html lang="ru">
            <head>
                <meta charset="UTF-8">
                <title>${info.videoDetails.title}</title>
                <meta property="og:site_name" content="Shorts Previewer">
                <meta property="og:title" content="${info.videoDetails.title}">
                <meta property="og:description" content="${info.videoDetails.description}">
                <meta property="og:image" content="${info.videoDetails.thumbnails[0].url}">
                <meta property="og:type" content="video.other">
                <meta property="og:url" content="https://www.youtube.com/watch?v=${videoId}">
                <meta property="og:video:url" content="${videoUrl}">
                <meta property="og:video:secure_url" content="${videoUrl}">
                <meta property="og:video:type" content="video/mp4">
                <meta property="og:video:width" content="1920">
                <meta property="og:video:height" content="1080">
            </head>
            <body>
                <p>Перенаправление...</p>
            </body>
            </html>
        `;

    res.send(html);
  } catch (error) {
    console.error('Error fetching video info:', error);
    res.status(500).send('Something went wrong');
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
