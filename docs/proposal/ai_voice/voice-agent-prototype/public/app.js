const form = document.querySelector("#message-form");
const messageInput = document.querySelector("#message");
const speakButton = document.querySelector("#speak");
const stopButton = document.querySelector("#stop");
const listenButton = document.querySelector("#listen");
const statusNode = document.querySelector("#status");
const responseCard = document.querySelector("#response-card");
const responseText = document.querySelector("#response-text");
const agentLabel = document.querySelector("#agent-label");

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognitionActive = false;
let finalTranscript = "";
let pendingManualMessage = "";
let currentReply = "";
let requestId = 0;
let voiceConversationActive = false;
let speechTurnId = 0;

function setStatus(text, kind = "info") {
  statusNode.textContent = text;
  statusNode.dataset.kind = kind;
}

function stopSpeaking() {
  ++speechTurnId;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function speakText(text, continueConversation = false) {
  if (!("speechSynthesis" in window) || !window.SpeechSynthesisUtterance) {
    setStatus("La síntesis de voz no está disponible en este navegador.", "error");
    return;
  }
  stopSpeaking();
  const ownSpeechTurn = ++speechTurnId;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "es-MX";
  utterance.onstart = () => {
    if (ownSpeechTurn !== speechTurnId) return;
    stopButton.disabled = false;
    setStatus("El agente está hablando.");
  };
  utterance.onend = () => {
    if (ownSpeechTurn !== speechTurnId) return;
    stopButton.disabled = true;
    setStatus("Respuesta terminada.");
    if (continueConversation && voiceConversationActive) startListening(true);
  };
  utterance.onerror = () => {
    if (ownSpeechTurn !== speechTurnId) return;
    stopButton.disabled = true;
    setStatus("No se pudo reproducir la voz. Use Escuchar respuesta.", "error");
  };
  window.speechSynthesis.speak(utterance);
}

async function sendMessage(message, continueConversation = false) {
  const ownRequest = ++requestId;
  speakButton.disabled = true;
  setStatus("El agente está preparando una respuesta.");
  try {
    const response = await fetch("/api/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Falló el agente");
    if (ownRequest !== requestId) return;
    currentReply = payload.reply;
    responseText.textContent = currentReply;
    agentLabel.textContent = `Agente: ${payload.agent}`;
    responseCard.hidden = false;
    setStatus("Respuesta recibida.");
    speakText(currentReply, continueConversation);
  } catch (error) {
    if (ownRequest !== requestId) return;
    setStatus(error.message || "No se pudo contactar al agente.", "error");
  } finally {
    if (ownRequest === requestId) speakButton.disabled = !Recognition;
  }
}

function configureRecognition() {
  if (!Recognition) {
    speakButton.disabled = true;
    speakButton.title = "Dictado no disponible; escriba su mensaje";
    return;
  }

  recognition = new Recognition();
  recognition.lang = "es-MX";
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.onstart = () => {
    recognitionActive = true;
    finalTranscript = "";
    stopSpeaking();
    speakButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Escuchando. Diga su mensaje.");
  };
  recognition.onresult = (event) => {
    finalTranscript = event.results[event.results.length - 1][0].transcript.trim();
    messageInput.value = finalTranscript;
    setStatus("Mensaje reconocido. Cerrando el micrófono.");
  };
  recognition.onerror = (event) => {
    finalTranscript = "";
    setStatus(`No se pudo reconocer la voz: ${event.error}.`, "error");
  };
  recognition.onend = () => {
    recognitionActive = false;
    speakButton.disabled = false;
    stopButton.disabled = true;
    const transcript = pendingManualMessage || finalTranscript;
    pendingManualMessage = "";
    finalTranscript = "";
    if (transcript) {
      sendMessage(transcript, voiceConversationActive);
    } else if (voiceConversationActive) {
      setStatus("No se detectó un mensaje. Pulse Hablar para continuar.");
    }
  };
}

function startListening(automatic = false) {
  stopSpeaking();
  try {
    recognition.start();
  } catch {
    setStatus(
      automatic
        ? "Pulse Hablar para continuar la conversación."
        : "El micrófono ya está activo. Espere un momento.",
      "error"
    );
  }
}

speakButton.addEventListener("click", () => {
  voiceConversationActive = true;
  startListening();
});

stopButton.addEventListener("click", () => {
  voiceConversationActive = false;
  pendingManualMessage = "";
  finalTranscript = "";
  stopSpeaking();
  recognition?.abort();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  voiceConversationActive = false;
  stopSpeaking();
  const message = messageInput.value.trim();
  if (!message) {
    setStatus("Escriba o diga un mensaje antes de enviarlo.", "error");
    messageInput.focus();
    return;
  }
  if (recognitionActive) {
    pendingManualMessage = message;
    finalTranscript = "";
    setStatus("Cerrando el micrófono antes de enviar.");
    recognition.abort();
    return;
  }
  sendMessage(message);
});

listenButton.addEventListener("click", () => {
  if (currentReply) speakText(currentReply, false);
});

window.addEventListener("beforeunload", () => {
  ++requestId;
  voiceConversationActive = false;
  recognition?.abort();
  stopSpeaking();
});

configureRecognition();
agentLabel.textContent = "Agente: pendiente del primer mensaje";
