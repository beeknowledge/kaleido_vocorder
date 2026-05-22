let mediaRecorder = null;
let audioChunks = [];

const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("recordStatus");
const audioInput = document.getElementById("audioInput");
const previewAudio = document.getElementById("previewAudio");

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function audioBufferToWav(buffer) {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

async function blobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioContext.decodeAudioData(arrayBuffer);
  const wavBlob = audioBufferToWav(decoded);
  await audioContext.close();
  return wavBlob;
}

recordBtn?.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    });

    mediaRecorder.addEventListener("stop", async () => {
      const rawBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      const wavBlob = await blobToWav(rawBlob);
      const file = new File([wavBlob], "browser_recording.wav", { type: "audio/wav" });

      const dt = new DataTransfer();
      dt.items.add(file);
      audioInput.files = dt.files;

      previewAudio.src = URL.createObjectURL(wavBlob);
      previewAudio.classList.remove("hidden");
      statusText.textContent = "録音をWAV化してセットしました。このまま変換できます。";

      stream.getTracks().forEach(track => track.stop());
    });

    mediaRecorder.start();
    recordBtn.disabled = true;
    stopBtn.disabled = false;
    statusText.textContent = "録音中です。話し終えたら停止してください。";
  } catch (err) {
    statusText.textContent = "マイクを開始できませんでした: " + err.message;
  }
});

stopBtn?.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    recordBtn.disabled = false;
    stopBtn.disabled = true;
  }
});
