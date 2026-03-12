/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, ThinkingLevel, Type } from "@google/genai";
import { 
  Mic, MicOff, Volume2, VolumeX, Newspaper, Settings, 
  Play, Square, Send, FileText, CheckCircle2, AlertCircle,
  Menu, X, MessageSquare, BarChart3, ChevronRight, SendHorizontal,
  Loader2, Sparkles, History, Globe, Zap, FileUp, Database
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Constants for Audio Processing
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const CHUNK_SIZE = 2048;

interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

interface Report {
  summary: string;
  conclusions: string[];
  recommendations?: string[];
}

interface Topic {
  id: string;
  name: string;
  description: string;
  systemInstruction: string;
  knowledgeBase?: string;
}

export default function App() {
  // UI State
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'report'>('chat');
  const [inputMode, setInputMode] = useState<'hands-free' | 'push-to-talk'>('hands-free');
  const [isPTTActive, setIsPTTActive] = useState(false);
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  
  // Refs to avoid stale closures in audio processing
  const inputModeRef = useRef(inputMode);
  const isPTTActiveRef = useRef(isPTTActive);

  useEffect(() => { inputModeRef.current = inputMode; }, [inputMode]);
  useEffect(() => { isPTTActiveRef.current = isPTTActive; }, [isPTTActive]);
  
  // Connection State
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState('READY');
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(0);
  const [isThinking, setIsThinking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  // Topics Configuration
  const defaultTopics: Topic[] = [
    { 
      id: 'ai', 
      name: '🤖 ИИ И АВТОМАТИЗАЦИЯ', 
      description: 'Новости про n8n, LLM, новые инструменты, кейсы автоматизации',
      systemInstruction: 'Ты — Джарвис, эксперт в области ИИ и автоматизации. Твоя задача — обсуждать последние новости n8n, LLM и инструментов автоматизации. Будь лаконичен и профессионален.',
      knowledgeBase: ''
    },
    { 
      id: 'business', 
      name: '💼 МАЛЫЙ БИЗНЕС', 
      description: 'Тренды, проблемы предпринимателей, маркетинг, продажи',
      systemInstruction: 'Ты — Джарвис, бизнес-консультант для малого бизнеса. Твоя задача — обсуждать тренды, маркетинг и продажи. Помогай предпринимателям находить решения.',
      knowledgeBase: ''
    },
    { 
      id: 'tg', 
      name: '📱 TELEGRAM И БОТЫ', 
      description: 'Обновления платформы, новые возможности, кейсы',
      systemInstruction: 'Ты — Джарвис, специалист по Telegram и разработке ботов. Обсуждай обновления платформы и интересные кейсы использования ботов.',
      knowledgeBase: ''
    },
    { 
      id: 'my', 
      name: '🎯 МОЙ БИЗНЕС', 
      description: 'Разговор про ORDO, планы, задачи дня',
      systemInstruction: 'Ты — Джарвис, личный ассистент Александра. Твоя задача — помогать с проектом ORDO, обсуждать планы и задачи на день. Будь в курсе всех деталей.',
      knowledgeBase: 'Проект ORDO: Инновационная система управления задачами и временем.'
    },
    { 
      id: 'free', 
      name: '⚙️ СВОБОДНАЯ ТЕМА', 
      description: 'Говори о чём хочешь',
      systemInstruction: 'Ты — Джарвис, универсальный ИИ-ассистент. Ты готов поддержать любую тему разговора, быть полезным и интересным собеседником.',
      knowledgeBase: ''
    },
  ];

  const [topics, setTopics] = useState<Topic[]>(() => {
    const saved = localStorage.getItem('jarvis_topics');
    return saved ? JSON.parse(saved) : defaultTopics;
  });

  // Data State
  const [selectedTopicId, setSelectedTopicId] = useState(topics[0].id);
  const selectedTopic = topics.find(t => t.id === selectedTopicId) || topics[0];
  const editingTopic = topics.find(t => t.id === editingTopicId);
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);

  // Telegram & News Config
  const [tgToken, setTgToken] = useState(localStorage.getItem('tg_token') || '');
  const [tgChatId, setTgChatId] = useState(localStorage.getItem('tg_chat_id') || '');
  const [newsApiKey, setNewsApiKey] = useState(localStorage.getItem('news_api_key') || '');
  const [tgStatus, setTgStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem('news_api_key', newsApiKey);
    localStorage.setItem('tg_token', tgToken);
    localStorage.setItem('tg_chat_id', tgChatId);
    localStorage.setItem('jarvis_topics', JSON.stringify(topics));
  }, [newsApiKey, tgToken, tgChatId, topics]);

  // Refs for Audio & Session
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueue = useRef<Int16Array[]>([]);
  const isPlaying = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const targetId = editingTopicId || selectedTopicId;
      const newTopics = topics.map(t => 
        t.id === targetId ? { ...t, knowledgeBase: (t.knowledgeBase || '') + '\n' + content } : t
      );
      setTopics(newTopics);
    };
    reader.readAsText(file);
  };

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Initialize Audio Context
  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: OUTPUT_SAMPLE_RATE,
      });
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
  };

  // Playback Logic
  const playNextInQueue = useCallback(async () => {
    if (audioQueue.current.length === 0 || !audioContextRef.current) {
      isPlaying.current = false;
      return;
    }

    if (isPlaying.current) return;

    isPlaying.current = true;

    try {
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      const chunk = audioQueue.current.shift()!;
      const audioBuffer = audioContextRef.current.createBuffer(1, chunk.length, OUTPUT_SAMPLE_RATE);
      const channelData = audioBuffer.getChannelData(0);
      
      for (let i = 0; i < chunk.length; i++) {
        channelData[i] = chunk[i] / 32768;
      }

      const source = audioContextRef.current.createBufferSource();
      currentSourceRef.current = source;
      source.buffer = audioBuffer;
      source.connect(audioContextRef.current.destination);
      
      source.onended = () => {
        if (currentSourceRef.current === source) {
          currentSourceRef.current = null;
        }
        isPlaying.current = false;
        playNextInQueue();
      };

      source.start();
    } catch (err) {
      console.error("Playback error:", err);
      isPlaying.current = false;
    }
  }, []);

  const connectToGemini = async () => {
    try {
      setStatus('СИНХРОНИЗАЦИЯ...');
      await initAudio();

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      // We'll set the session ref as soon as connect is called
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Fenrir" } },
          },
          tools: [
            { googleSearch: {} },
            {
              functionDeclarations: [
                {
                  name: "send_telegram_summary",
                  description: "Отправляет краткую сводку новостей или итогов в Телеграм.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      message: {
                        type: Type.STRING,
                        description: "Текст сообщения для отправки."
                      }
                    },
                    required: ["message"]
                  }
                }
              ]
            }
          ],
          systemInstruction: `Ты — Джарвис, личный ассистент Александра Гребенщикова.
Александр находится в Москве (МСК, UTC+3).

Твои задачи:
1. Твоя основная роль и инструкции: ${selectedTopic.systemInstruction}
2. Вести максимально живой и быстрый диалог. Отвечай кратко, по существу.
3. Если Александр просит отправить сводку в Телеграм — используй инструмент send_telegram_summary.
4. Если Александр начинает говорить — ты должен мгновенно замолчать и слушать.

База знаний для текущего режима:
${selectedTopic.knowledgeBase || 'Дополнительная база знаний не предоставлена.'}

Стиль общения:
- Голос Джарвиса: уверенный, спокойный, профессиональный, мужской.
- Лаконичность: 1-2 предложения, если не требуется подробный ответ.
- Никаких "Конечно", "Разумеется", "Я вас поняла". Сразу к делу.
- Текущая дата и время в Москве: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}.`,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setStatus('LIVE');
            startRecording();
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio
            if (message.serverContent?.modelTurn?.parts) {
              setIsThinking(false);
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                  const binaryString = atob(part.inlineData.data);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  const int16Array = new Int16Array(bytes.buffer);
                  audioQueue.current.push(int16Array);
                  playNextInQueue();
                }
              }
            }

            // Handle Transcriptions for UI
            if (message.serverContent?.modelTurn?.parts) {
              const text = message.serverContent.modelTurn.parts.map(p => p.text).join(' ');
              if (text) {
                setMessages(prev => [...prev, { role: 'model', text, timestamp: Date.now() }]);
              }
            }

            // Handle Tool Calls
            if (message.toolCall) {
              for (const call of message.toolCall.functionCalls) {
                if (call.name === 'send_telegram_summary') {
                  const { message: text } = call.args as { message: string };
                  try {
                    const token = tgToken || process.env.TELEGRAM_BOT_TOKEN;
                    const chatId = tgChatId || process.env.TELEGRAM_CHAT_ID;
                    
                    if (!token || !chatId) {
                      sessionRef.current?.sendToolResponse({
                        functionResponses: [{
                          name: call.name,
                          id: call.id,
                          response: { error: "Telegram не настроен. Укажите Token и Chat ID в настройках." }
                        }]
                      });
                      continue;
                    }

                    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ chat_id: chatId, text: `🤖 Джарвис: ${text}` })
                    });

                    sessionRef.current?.sendToolResponse({
                      functionResponses: [{
                        name: call.name,
                        id: call.id,
                        response: { success: true }
                      }]
                    });
                  } catch (err) {
                    console.error("Telegram send error:", err);
                  }
                }
              }
            }

            if (message.serverContent?.interrupted) {
              currentSourceRef.current?.stop();
              currentSourceRef.current = null;
              audioQueue.current = [];
              isPlaying.current = false;
            }
          },
          onclose: () => {
            setIsConnected(false);
            stopRecording();
            setStatus('STANDBY');
          },
          onerror: (err) => {
            console.error("Gemini Live Error:", err);
            setStatus('OFFLINE');
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Failed to connect:", err);
      setStatus('ERROR');
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const source = audioContextRef.current!.createMediaStreamSource(stream);
      const processor = audioContextRef.current!.createScriptProcessor(CHUNK_SIZE, 1, 1);
      
      processor.onaudioprocess = (e) => {
        if (!sessionRef.current || isMuted) return;
        
        // Push-to-talk logic using refs to avoid stale closures
        if (inputModeRef.current === 'push-to-talk' && !isPTTActiveRef.current) return;

        const inputData = e.inputBuffer.getChannelData(0);
        
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const vol = Math.sqrt(sum / inputData.length);
        setVolume(vol);

        // If user is speaking, set visual feedback
        const speaking = vol > 0.015;
        setIsUserSpeaking(speaking);
        if (speaking) {
          setIsThinking(true);
          // Stop current AI playback if user starts speaking
          if (currentSourceRef.current) {
            currentSourceRef.current.stop();
            currentSourceRef.current = null;
            audioQueue.current = [];
            isPlaying.current = false;
          }
        }

        const int16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          int16Data[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
        }

        const base64Data = btoa(String.fromCharCode(...new Uint8Array(int16Data.buffer)));
        sessionRef.current?.sendRealtimeInput({
          media: { data: base64Data, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` }
        });
      };

      source.connect(processor);
      processor.connect(audioContextRef.current!.destination);
      processorRef.current = processor;
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setStatus('MIC ERROR');
    }
  };

  const stopRecording = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    processorRef.current?.disconnect();
    setVolume(0);
  };

  const toggleConnection = () => {
    if (isConnected) {
      sessionRef.current?.close();
    } else {
      connectToGemini();
    }
  };

  // Auto-reconnect on topic change if live
  useEffect(() => {
    if (isConnected) {
      sessionRef.current?.close();
      const timer = setTimeout(() => {
        connectToGemini();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [selectedTopicId]);

  const generateReport = async () => {
    if (messages.length === 0) return;
    setIsGeneratingReport(true);
    setActiveTab('report');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const dialogue = messages.map(m => `${m.role === 'user' ? 'Александр' : 'ORDO'}: ${m.text}`).join('\n');
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Ты — ассистент ORDO. На основе диалога с Александром Гребенщиковым составь утреннюю сводку.
        Диалог:
        ${dialogue}
        
        Формат ответа JSON:
        {
          "summary": "Краткое резюме разговора (3-4 предложения)",
          "insights": ["инсайт 1", "инсайт 2", "инсайт 3"],
          "recommendations": ["действие 1", "действие 2", "действие 3"]
        }`,
        config: { responseMimeType: "application/json" }
      });

      const result = JSON.parse(response.text || '{}');
      setReport({
        summary: result.summary,
        conclusions: result.insights,
        recommendations: result.recommendations
      });
    } catch (err) {
      console.error("Report generation failed:", err);
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const sendToTelegram = async () => {
    if (!report || !tgToken || !tgChatId) {
      setTgStatus('error');
      return;
    }

    setTgStatus('sending');
    const dateStr = new Date().toLocaleString('ru-RU');
    const text = `🌅 *Утренняя сводка ORDO*\n${dateStr}\n\n📰 *Главное из новостей:*\n${report.conclusions.map(c => `— ${c}`).join('\n')}\n\n💬 *Обсудили:*\n${report.summary}\n\n🎯 *Рекомендации на сегодня:*\n${report.recommendations?.map((r, i) => `${i+1}. ${r}`).join('\n')}\n\n⏱ *Сессия завершена*`;

    try {
      const response = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChatId,
          text: text,
          parse_mode: 'Markdown'
        })
      });

      if (response.ok) {
        setTgStatus('success');
        setTimeout(() => setTgStatus('idle'), 3000);
      } else {
        setTgStatus('error');
      }
    } catch (err) {
      setTgStatus('error');
    }
  };

  return (
    <div className="flex h-screen bg-midnight text-slate-200 font-sans overflow-hidden selection:bg-blue-500/30">
      {/* Immersive Background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden premium-gradient">
        <div className="absolute top-[-10%] left-[-5%] w-[50%] h-[50%] bg-blue-900/10 blur-[120px] rounded-full animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[50%] h-[50%] bg-indigo-900/10 blur-[120px] rounded-full animate-pulse" style={{ animationDelay: '3s' }} />
      </div>

      {/* Sidebar Settings */}
      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 bg-black/80 backdrop-blur-md z-40"
            />
            <motion.aside
              initial={{ x: -320 }}
              animate={{ x: 0 }}
              exit={{ x: -320 }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed inset-y-0 left-0 w-full sm:w-80 bg-deep-navy/95 backdrop-blur-3xl border-r border-white/5 z-50 p-6 sm:p-10 flex flex-col gap-8 shadow-2xl"
            >
              <div className="flex justify-between items-center">
                <h2 className="text-[10px] font-black tracking-[0.5em] text-blue-400/50 uppercase font-mono">System.Config</h2>
                <button onClick={() => setIsSidebarOpen(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors text-white/20 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-8 overflow-y-auto custom-scrollbar pr-2">
                <div className="space-y-4">
                  <div className="flex justify-between items-center ml-1">
                    <label className="text-[9px] uppercase tracking-[0.4em] text-white/20 font-bold">Focus Mode</label>
                  </div>
                  
                  <AnimatePresence mode="wait">
                    {editingTopicId ? (
                      <motion.div
                        key="editor"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-4 bg-white/[0.02] border border-white/5 rounded-xl p-4"
                      >
                        <div className="flex justify-between items-center px-1">
                          <div className="flex items-center gap-2">
                            <button 
                              onClick={() => setEditingTopicId(null)}
                              className="p-1 hover:bg-white/5 rounded-lg text-white/40 hover:text-white transition-colors"
                            >
                              <ChevronRight className="rotate-180" size={14} />
                            </button>
                            <span className="text-[9px] uppercase tracking-[0.4em] text-blue-400 font-bold">Editor: {editingTopic?.name.split(' ').pop()}</span>
                          </div>
                          <button 
                            onClick={() => {
                              const defaultTopic = defaultTopics.find(dt => dt.id === editingTopicId);
                              if (defaultTopic) {
                                const newTopics = topics.map(t => 
                                  t.id === editingTopicId ? { ...t, systemInstruction: defaultTopic.systemInstruction, knowledgeBase: defaultTopic.knowledgeBase } : t
                                );
                                setTopics(newTopics);
                              }
                            }}
                            className="text-[7px] uppercase tracking-[0.2em] text-white/20 hover:text-red-400 transition-colors"
                          >
                            Reset
                          </button>
                        </div>
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <span className="text-[8px] uppercase tracking-[0.3em] text-white/10 ml-1">System Instruction</span>
                            <textarea
                              value={editingTopic?.systemInstruction || ''}
                              onChange={(e) => {
                                const newTopics = topics.map(t => 
                                  t.id === editingTopicId ? { ...t, systemInstruction: e.target.value } : t
                                );
                                setTopics(newTopics);
                              }}
                              className="w-full bg-black/40 border border-white/5 rounded-lg p-3 text-[10px] leading-relaxed outline-none focus:border-blue-500/30 transition-all font-sans text-white/70 h-32 custom-scrollbar resize-none"
                              placeholder="Введите инструкции для этого режима..."
                            />
                          </div>

                          <div className="space-y-2">
                            <div className="flex justify-between items-center ml-1">
                              <span className="text-[8px] uppercase tracking-[0.3em] text-white/10">Инструкции и Файлы</span>
                              <div className="flex items-center gap-3">
                                <button 
                                  onClick={() => {
                                    const newTopics = topics.map(t => 
                                      t.id === editingTopicId ? { ...t, knowledgeBase: '' } : t
                                    );
                                    setTopics(newTopics);
                                  }}
                                  className="text-[7px] uppercase tracking-[0.1em] text-red-400/40 hover:text-red-400 transition-colors"
                                >
                                  Clear
                                </button>
                                <button 
                                  onClick={() => fileInputRef.current?.click()}
                                  className="flex items-center gap-1.5 text-[7px] uppercase tracking-[0.1em] text-blue-400/60 hover:text-blue-400 transition-colors"
                                >
                                  <FileUp size={10} />
                                  <span>Upload File</span>
                                </button>
                              </div>
                              <input 
                                type="file" 
                                ref={fileInputRef} 
                                onChange={handleFileUpload} 
                                className="hidden" 
                                accept=".txt,.md,.json"
                              />
                            </div>
                            <textarea
                              value={editingTopic?.knowledgeBase || ''}
                              onChange={(e) => {
                                const newTopics = topics.map(t => 
                                  t.id === editingTopicId ? { ...t, knowledgeBase: e.target.value } : t
                                );
                                setTopics(newTopics);
                              }}
                              className="w-full bg-black/40 border border-white/5 rounded-lg p-3 text-[10px] leading-relaxed outline-none focus:border-blue-500/30 transition-all font-sans text-white/70 h-48 custom-scrollbar resize-none"
                              placeholder="Добавьте базу знаний или загрузите файлы..."
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-[8px] text-white/20 italic px-1">
                          <Sparkles size={10} />
                          <span>Инструкции для {editingTopic?.name}</span>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="list"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="grid grid-cols-1 gap-2"
                      >
                        {topics.map((t) => (
                          <div key={t.id} className="relative group">
                            <button
                              onClick={() => setSelectedTopicId(t.id)}
                              className={cn(
                                "w-full text-left p-4 rounded-xl border transition-all duration-300 pr-12",
                                selectedTopicId === t.id 
                                  ? "bg-blue-600 text-white border-blue-500 shadow-[0_0_20px_rgba(37,99,235,0.2)]" 
                                  : "bg-white/[0.02] border-white/5 hover:border-white/20"
                              )}
                            >
                              <div className="text-[10px] font-bold uppercase tracking-wider mb-1">{t.name}</div>
                              <div className="text-[8px] opacity-50 leading-tight">{t.description}</div>
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingTopicId(t.id);
                              }}
                              className={cn(
                                "absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg transition-all",
                                selectedTopicId === t.id ? "text-white/40 hover:text-white hover:bg-white/10" : "text-white/10 hover:text-blue-400 hover:bg-blue-500/10"
                              )}
                            >
                              <Settings size={14} />
                            </button>
                          </div>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="space-y-4">
                  <label className="text-[9px] uppercase tracking-[0.4em] text-white/20 font-bold ml-1">Input Protocol</label>
                  <div className="flex bg-white/5 rounded-xl p-1 border border-white/5">
                    <button
                      onClick={() => setInputMode('push-to-talk')}
                      className={cn(
                        "flex-1 py-2.5 rounded-lg text-[8px] uppercase tracking-widest font-bold transition-all",
                        inputMode === 'push-to-talk' ? "bg-white/10 text-white border border-white/10" : "text-white/30 hover:text-white/50"
                      )}
                    >
                      PTT
                    </button>
                    <button
                      onClick={() => setInputMode('hands-free')}
                      className={cn(
                        "flex-1 py-2.5 rounded-lg text-[8px] uppercase tracking-widest font-bold transition-all",
                        inputMode === 'hands-free' ? "bg-white/10 text-white border border-white/10" : "text-white/30 hover:text-white/50"
                      )}
                    >
                      Hands-free
                    </button>
                  </div>
                </div>

                <div className="space-y-6 border-t border-white/5 pt-8">
                  <h3 className="text-[9px] uppercase tracking-[0.4em] text-white/20 font-bold ml-1">External Links</h3>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <span className="text-[8px] uppercase tracking-[0.3em] text-white/10 ml-1">NewsAPI Key</span>
                      <input
                        type="password"
                        placeholder="••••••••"
                        value={newsApiKey}
                        onChange={(e) => setNewsApiKey(e.target.value)}
                        className="w-full bg-white/[0.02] border border-white/5 rounded-xl p-4 text-[10px] outline-none focus:border-blue-500/50 transition-all font-mono text-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <span className="text-[8px] uppercase tracking-[0.3em] text-white/10 ml-1">Telegram Token</span>
                      <input
                        type="password"
                        placeholder="••••••••"
                        value={tgToken}
                        onChange={(e) => setTgToken(e.target.value)}
                        className="w-full bg-white/[0.02] border border-white/5 rounded-xl p-4 text-[10px] outline-none focus:border-blue-500/50 transition-all font-mono text-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <span className="text-[8px] uppercase tracking-[0.3em] text-white/10 ml-1">Chat ID</span>
                      <input
                        type="text"
                        placeholder="ID"
                        value={tgChatId}
                        onChange={(e) => setTgChatId(e.target.value)}
                        className="w-full bg-white/[0.02] border border-white/5 rounded-xl p-4 text-[10px] outline-none focus:border-blue-500/50 transition-all font-mono text-white"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-auto pt-6 border-t border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-3 text-blue-400/30">
                  <Zap size={10} className="animate-pulse" />
                  <span className="text-[8px] uppercase tracking-[0.3em] font-bold font-mono">Link: Active</span>
                </div>
                <span className="text-[8px] text-white/10 font-mono tracking-tighter">JARVIS_OS_v4.0</span>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative z-10">
        {/* Minimal Navbar */}
        <nav className="h-20 sm:h-24 flex items-center justify-between px-6 sm:px-12 border-b border-white/5 bg-midnight/50 backdrop-blur-md">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="group flex items-center gap-3 text-white/40 hover:text-white transition-all">
              <div className="w-10 h-10 rounded-xl border border-white/5 flex items-center justify-center group-hover:border-blue-500/50 group-hover:bg-blue-500/5 transition-all duration-500">
                <Settings size={16} />
              </div>
              <div className="hidden sm:flex flex-col">
                <span className="text-[9px] uppercase tracking-[0.4em] font-bold leading-none mb-1">{selectedTopic.name}</span>
                <span className="text-[8px] text-white/10 uppercase tracking-widest font-mono">Active Protocol</span>
              </div>
            </button>
          </div>

          <div className="flex items-center bg-white/[0.03] border border-white/5 rounded-2xl p-1">
            <button 
              onClick={() => setActiveTab('chat')}
              className={cn(
                "px-6 sm:px-10 py-2.5 rounded-xl text-[9px] uppercase tracking-[0.3em] font-bold transition-all duration-500",
                activeTab === 'chat' ? "bg-white/10 text-white border border-white/10 shadow-xl" : "text-white/30 hover:text-white/60"
              )}
            >
              Session
            </button>
            <button 
              onClick={() => setActiveTab('report')}
              className={cn(
                "px-6 sm:px-10 py-2.5 rounded-xl text-[9px] uppercase tracking-[0.3em] font-bold transition-all duration-500",
                activeTab === 'report' ? "bg-white/10 text-white border border-white/10 shadow-xl" : "text-white/30 hover:text-white/60"
              )}
            >
              Analysis
            </button>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <div className="flex items-center gap-2 mb-1">
                <div className={cn("w-1.5 h-1.5 rounded-full", isConnected ? "bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.8)] animate-pulse" : "bg-white/10")} />
                <span className="hidden sm:inline text-[8px] uppercase tracking-[0.4em] text-white/20 font-bold">Status</span>
              </div>
              <span className={cn("text-[9px] sm:text-[10px] font-mono tracking-[0.1em] uppercase", isConnected ? "text-blue-400" : "text-white/40")}>
                {status}
              </span>
            </div>
          </div>
        </nav>

        {/* Content View */}
        <div className="flex-1 overflow-hidden relative">
          <AnimatePresence mode="wait">
            {activeTab === 'chat' ? (
              <motion.div
                key="chat"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="h-full flex flex-col items-center justify-center px-6 sm:px-12 pb-20"
              >
                {/* Visualizer Centerpiece */}
                <div className="relative mb-16 sm:mb-24">
                  {/* Atmospheric Glows */}
                  <AnimatePresence>
                    {isConnected && (
                      <>
                        <motion.div
                          initial={{ scale: 0.8, opacity: 0 }}
                          animate={{ scale: 1.8, opacity: 1 }}
                          exit={{ scale: 0.8, opacity: 0 }}
                          className="absolute inset-0 rounded-full bg-blue-600/10 blur-[100px] sm:blur-[160px]"
                        />
                        <motion.div
                          animate={{ 
                            scale: isUserSpeaking ? [1, 1.3, 1] : 1,
                            opacity: isUserSpeaking ? [0.1, 0.3, 0.1] : 0.1
                          }}
                          transition={{ repeat: Infinity, duration: 2 }}
                          className="absolute inset-[-60%] rounded-full bg-indigo-600/10 blur-[120px] sm:blur-[180px]"
                        />
                      </>
                    )}
                  </AnimatePresence>

                  <div className="relative w-72 h-72 sm:w-96 sm:h-96 flex items-center justify-center">
                    {/* Technical Rings */}
                    <motion.div 
                      animate={{ 
                        rotate: isConnected ? 360 : 0,
                        scale: isUserSpeaking ? 1.1 : 1
                      }}
                      transition={{ rotate: { repeat: Infinity, duration: 30, ease: "linear" } }}
                      className="absolute inset-0 rounded-full border border-blue-500/10 border-t-blue-500/40" 
                    />
                    <motion.div 
                      animate={{ 
                        rotate: isConnected ? -360 : 0,
                        scale: isThinking ? [1.05, 1.1, 1.05] : 1.05
                      }}
                      transition={{ rotate: { repeat: Infinity, duration: 20, ease: "linear" } }}
                      className="absolute inset-6 rounded-full border border-dashed border-indigo-500/20" 
                    />
                    <div className={cn(
                      "absolute inset-12 rounded-full border border-white/5 transition-all duration-1000",
                      isConnected ? "opacity-100" : "opacity-0"
                    )} />

                    {/* Core Orb */}
                    <button
                      onMouseDown={() => inputMode === 'push-to-talk' && isConnected && setIsPTTActive(true)}
                      onMouseUp={() => inputMode === 'push-to-talk' && isConnected && setIsPTTActive(false)}
                      onTouchStart={() => inputMode === 'push-to-talk' && isConnected && setIsPTTActive(true)}
                      onTouchEnd={() => inputMode === 'push-to-talk' && isConnected && setIsPTTActive(false)}
                      onClick={toggleConnection}
                      className={cn(
                        "w-56 h-56 sm:w-72 sm:h-72 rounded-full flex flex-col items-center justify-center gap-6 transition-all duration-700 border relative overflow-hidden group",
                        isConnected 
                          ? (isPTTActive || inputMode === 'hands-free' ? "bg-blue-600 border-blue-400 shadow-[0_0_80px_rgba(37,99,235,0.4)]" : "bg-deep-navy border-white/10")
                          : "bg-deep-navy border-white/5 hover:border-blue-500/30"
                      )}
                    >
                      <AnimatePresence mode="wait">
                        {isConnected ? (
                          <motion.div
                            key="on"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 1.1 }}
                            className="flex flex-col items-center gap-6"
                          >
                            <div className="flex items-center gap-2">
                              {[...Array(9)].map((_, i) => (
                                <motion.div
                                  key={i}
                                  animate={{ 
                                    height: isUserSpeaking ? [12, 56, 12] : [6, 20, 6],
                                    opacity: isUserSpeaking ? 1 : 0.4
                                  }}
                                  transition={{ 
                                    repeat: Infinity, 
                                    duration: isUserSpeaking ? 0.4 : 1.5, 
                                    delay: i * 0.08 
                                  }}
                                  className={cn("w-1 rounded-full", isPTTActive || inputMode === 'hands-free' ? "bg-white" : "bg-blue-500")}
                                />
                              ))}
                            </div>
                            <motion.span 
                              animate={{ opacity: isPlaying.current ? [0.4, 1, 0.4] : 0.8 }}
                              transition={{ repeat: Infinity, duration: 2 }}
                              className="text-[9px] uppercase tracking-[0.5em] font-black font-mono"
                            >
                              {inputMode === 'push-to-talk' ? (isPTTActive ? 'LISTENING' : 'HOLD TO SPEAK') : 'ACTIVE'}
                            </motion.span>
                          </motion.div>
                        ) : (
                          <motion.div
                            key="off"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 1.1 }}
                            className="flex flex-col items-center gap-6"
                          >
                            <div className="w-16 h-16 rounded-2xl bg-white/[0.03] flex items-center justify-center group-hover:scale-110 group-hover:bg-blue-500/10 transition-all duration-500 border border-white/5 group-hover:border-blue-500/50">
                              <Mic size={24} className="text-white/20 group-hover:text-blue-400 transition-colors" />
                            </div>
                            <span className="text-[9px] uppercase tracking-[0.6em] font-black opacity-30 group-hover:opacity-100 transition-all duration-500">Initialize Jarvis</span>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </button>
                  </div>
                </div>

                {/* Transcription HUD */}
                <div className="w-full max-w-lg relative">
                  <AnimatePresence>
                    {messages.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="relative"
                      >
                        <div className="absolute -top-6 left-1/2 -translate-x-1/2 flex items-center gap-2 opacity-20">
                          <div className="w-8 h-[1px] bg-blue-500" />
                          <span className="text-[7px] uppercase tracking-[0.5em] font-mono font-bold text-blue-400">Comm_Link</span>
                          <div className="w-8 h-[1px] bg-blue-500" />
                        </div>
                        
                        <div className="h-20 overflow-y-auto custom-scrollbar flex flex-col gap-3 px-4 py-2 mask-fade-edges">
                          {messages.slice(-2).map((msg, idx) => (
                            <motion.div
                              key={idx}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className={cn(
                                "text-[11px] tracking-wider leading-relaxed font-mono text-center",
                                msg.role === 'user' ? "text-blue-400/40" : "text-white/40"
                              )}
                            >
                              <span className="opacity-30 mr-2">[{msg.role === 'user' ? 'USR' : 'JAR'}]</span>
                              {msg.text}
                            </motion.div>
                          ))}
                          <div ref={chatEndRef} />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Bottom Actions */}
                <div className="mt-12 flex flex-col gap-4 w-full max-w-xs sm:max-w-none items-center">
                  {isConnected && (
                      <motion.button
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        whileHover={{ scale: 1.02, backgroundColor: 'rgba(239, 68, 68, 0.2)' }}
                        whileTap={{ scale: 0.98 }}
                        onClick={toggleConnection}
                        className="w-full sm:w-auto px-10 py-4 rounded-xl bg-red-500/10 border border-red-500/20 transition-all text-[9px] uppercase tracking-[0.4em] font-black flex items-center justify-center gap-4 group text-red-500"
                      >
                        <Square size={14} />
                        Terminate Session
                      </motion.button>
                  )}
                  {messages.length > 0 && !isConnected && (
                      <motion.button
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        whileHover={{ scale: 1.02, backgroundColor: 'rgba(255, 255, 255, 0.05)' }}
                        whileTap={{ scale: 0.98 }}
                        onClick={generateReport}
                        className="w-full sm:w-auto px-10 py-4 rounded-xl bg-white/[0.02] border border-white/5 transition-all text-[9px] uppercase tracking-[0.4em] font-black flex items-center justify-center gap-4 group"
                      >
                        <BarChart3 size={14} className="text-white/40 group-hover:text-white transition-colors" />
                        Generate Intelligence Report
                      </motion.button>
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="report"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="h-full p-6 sm:p-16 overflow-y-auto custom-scrollbar"
              >
                <div className="max-w-4xl mx-auto space-y-16 sm:space-y-24">
                  <header className="flex flex-col sm:flex-row justify-between items-start sm:items-end border-b border-white/5 pb-10 gap-8">
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-[1px] bg-blue-500" />
                        <span className="text-[9px] uppercase tracking-[0.5em] text-blue-500 font-black">Classified</span>
                      </div>
                      <h2 className="text-5xl sm:text-7xl font-serif italic tracking-tight leading-none text-white">Intelligence Brief</h2>
                      <p className="text-[10px] text-white/20 uppercase tracking-[0.5em] font-bold font-mono">JARVIS_INTEL_CORE • {selectedTopic.name}</p>
                    </div>
                    <div className="text-left sm:text-right space-y-2">
                      <p className="text-[9px] uppercase tracking-[0.3em] text-white/10 font-bold">Timestamp</p>
                      <p className="text-lg font-serif italic text-white/40">{new Date().toLocaleDateString('ru-RU', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
                    </div>
                  </header>

                  {isGeneratingReport ? (
                    <div className="py-32 flex flex-col items-center gap-8">
                      <div className="w-12 h-12 border-2 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
                      <p className="text-[10px] uppercase tracking-[0.6em] text-white/20 font-black animate-pulse">Processing Data Streams</p>
                    </div>
                  ) : report ? (
                    <div className="space-y-16 sm:space-y-24">
                      <section className="grid grid-cols-1 sm:grid-cols-4 gap-8 sm:gap-16">
                        <div className="col-span-1">
                          <h3 className="text-[9px] uppercase tracking-[0.5em] text-blue-400/40 font-black flex items-center gap-4">
                            <div className="w-1.5 h-1.5 bg-blue-500 rounded-full" /> Executive Summary
                          </h3>
                        </div>
                        <div className="col-span-1 sm:col-span-3 text-xl sm:text-3xl font-serif leading-relaxed text-white/90 italic font-light">
                          {report.summary}
                        </div>
                      </section>

                      <section className="grid grid-cols-1 sm:grid-cols-4 gap-8 sm:gap-16">
                        <div className="col-span-1">
                          <h3 className="text-[9px] uppercase tracking-[0.5em] text-blue-400/40 font-black flex items-center gap-4">
                            <div className="w-1.5 h-1.5 bg-blue-500 rounded-full" /> Key Insights
                          </h3>
                        </div>
                        <div className="col-span-1 sm:col-span-3 space-y-10 sm:space-y-16">
                          {report.conclusions.map((item, i) => (
                            <div key={i} className="group flex gap-8 sm:gap-12 items-start">
                              <span className="text-[10px] font-mono text-blue-500/30 mt-1.5 tracking-tighter">0{i+1}</span>
                              <p className="text-lg sm:text-xl text-white/50 group-hover:text-white transition-all duration-700 leading-relaxed font-light">{item}</p>
                            </div>
                          ))}
                        </div>
                      </section>

                      {report.recommendations && (
                        <section className="grid grid-cols-1 sm:grid-cols-4 gap-8 sm:gap-16">
                          <div className="col-span-1">
                            <h3 className="text-[9px] uppercase tracking-[0.5em] text-blue-400/40 font-black flex items-center gap-4">
                              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full" /> Directives
                            </h3>
                          </div>
                          <div className="col-span-1 sm:col-span-3 space-y-4 sm:space-y-6">
                            {report.recommendations.map((item, i) => (
                              <div key={i} className="flex gap-6 items-center bg-white/[0.01] border border-white/5 p-6 sm:p-8 rounded-3xl hover:bg-blue-500/5 hover:border-blue-500/20 transition-all duration-500 group">
                                <div className="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center text-[10px] font-mono text-white/20 group-hover:text-blue-400 group-hover:bg-blue-500/10 transition-all duration-500 shrink-0">
                                  {i+1}
                                </div>
                                <p className="text-base sm:text-lg text-white/70 font-light group-hover:text-white transition-colors">{item}</p>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}

                      <div className="pt-16 sm:pt-24 flex justify-center">
                        <motion.button
                          whileHover={{ scale: 1.05, boxShadow: '0 0 40px rgba(59, 130, 246, 0.2)' }}
                          whileTap={{ scale: 0.95 }}
                          onClick={sendToTelegram}
                          disabled={tgStatus === 'sending'}
                          className={cn(
                            "w-full sm:w-auto px-12 sm:px-20 py-6 sm:py-7 rounded-2xl font-black uppercase tracking-[0.5em] text-[10px] flex items-center justify-center gap-6 transition-all border",
                            tgStatus === 'success' ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : 
                            tgStatus === 'error' ? "bg-red-500/10 border-red-500/30 text-red-400" :
                            "bg-blue-600 text-white border-blue-500 shadow-2xl"
                          )}
                        >
                          {tgStatus === 'sending' ? <Loader2 className="animate-spin" size={18} /> : 
                           tgStatus === 'success' ? <CheckCircle2 size={18} /> :
                           tgStatus === 'error' ? <AlertCircle size={18} /> :
                           <SendHorizontal size={18} />}
                          {tgStatus === 'success' ? 'Transmission Complete' : 
                           tgStatus === 'error' ? 'Transmission Failed' :
                           'Dispatch to Telegram'}
                        </motion.button>
                      </div>
                    </div>
                  ) : (
                    <div className="py-32 text-center space-y-8">
                      <div className="w-20 h-20 rounded-3xl border border-white/5 flex items-center justify-center mx-auto opacity-10">
                        <History size={32} />
                      </div>
                      <p className="text-[10px] uppercase tracking-[0.6em] text-white/20 font-black">Memory Banks Empty</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Inter:wght@300;400;600;900&family=JetBrains+Mono:wght@400;700&display=swap');
        
        body {
          font-family: 'Inter', sans-serif;
          background-color: #0a0a0a;
        }
        
        .font-serif {
          font-family: 'Cormorant Garamond', serif;
        }

        .font-mono {
          font-family: 'JetBrains Mono', monospace;
        }

        .custom-scrollbar::-webkit-scrollbar {
          width: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(59, 130, 246, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(59, 130, 246, 0.2);
        }

        .mask-fade-edges {
          mask-image: linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%);
        }
      `}} />
    </div>
  );
}
