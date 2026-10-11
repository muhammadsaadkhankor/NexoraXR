# Lecture 3 — Multimedia Computing: Compression

**Course:** Multimedia Computing
**Professor narration script** — each block is one spoken segment (maps 1:1 to slides).

---

## Segment 1 — Welcome Back

Welcome back. Last time we explored multimedia data sources — sensors, IoT devices, and the networks that carry their output. Today we run into the problem those sources create: multimedia data is enormous. A single minute of raw high-definition video is gigabytes, and we generate more data now than at any point in history. In Lecture 3, our focus is compression — the techniques that shrink text, images, audio, and video down to sizes we can actually store and transmit. As we go, watch for the trade-off every compressor makes between size and quality — it will come up again when we discuss quality of experience. Let's begin.

## Segment 2 — Big Data and Motivation

Why does compression matter so much now? Because the world is collecting data at a rate and a scale we have never seen before — from every sensor, camera, and transaction. This is the field called big data: datasets too large or complex for traditional processing software to handle. Analysts describe it with five V's — volume, variety, velocity, value, and veracity. Multimedia sits at the heart of that challenge: video and audio are the biggest, fastest-moving data types we produce, and without compression the whole ecosystem would simply not fit on disks or wires.

## Segment 3 — Compression Fundamentals

At its core, compression removes redundancy. There are two families. Lossless compression shrinks data with zero information loss — unzip it and every bit comes back exactly. Text, medical images, and financial records must be lossless. Lossy compression throws away detail the human senses barely notice — a photo keeps its look while losing hidden precision. The reward is far smaller files. Every multimedia codec you will meet this term is a carefully engineered answer to one question: which bits can we drop without the audience noticing?

## Segment 4 — Image Compression: JPEG and JPEG2000

Let's make that concrete with images. JPEG, the format behind almost every photo on the internet, is a lossy codec: it transforms image blocks into frequencies and discards the fine detail your eyes are insensitive to — that is why you can dial a JPEG's quality down and watch artifacts creep in. JPEG2000 improved on it with wavelet compression, giving better quality at the same size plus extras like progressive loading and regions of interest. The key lesson: compression is not magic — it is mathematics aimed at human perception.

## Segment 5 — Video Compression and MPEG

Video takes compression much further because it can exploit time. A video is largely the same scene, frame after frame — so instead of storing every frame, codecs store a full reference frame occasionally and only the changes in between, plus motion vectors predicting where blocks of pixels move. That is the idea behind the MPEG family — MPEG-1, MPEG-2, MPEG-4, and modern descendants like H.264 and H.265. Every stream you watch, every video call you join, runs on this family of ideas: spatial compression within a frame, temporal prediction across frames.

## Segment 6 — Compression in the Real World

Remember our 6G and IoT discussion? Compression is what makes those systems feasible. A hospital cannot ship raw imaging data over a network; a smart home cannot stream uncompressed video from every camera; a lecture like this one cannot be delivered to your phone without heavy compression of audio and slides. Requirements differ — live calls need low latency, archives need maximum fidelity — so engineers choose codecs and bitrates to match the application. Compression is not one algorithm; it is a discipline of trade-offs.

## Segment 7 — Wrap-Up

Today we motivated compression with the big data explosion and its five V's, separated lossless from lossy, saw how JPEG and JPEG2000 squeeze images by attacking what your eyes ignore, and how MPEG-family video codecs exploit temporal redundancy. Next lecture we shift from data to people — how humans interact with multimedia through multiple senses at once. See you then.
