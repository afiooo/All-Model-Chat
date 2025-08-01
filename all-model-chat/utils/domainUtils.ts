
import { ChatMessage, ContentPart, UploadedFile, ChatHistoryItem, SavedChatSession } from '../types';
import { SUPPORTED_IMAGE_MIME_TYPES } from '../constants/fileConstants';
import { logService } from '../services/logService';

export const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const result = reader.result as string;
            const base64Data = result.split(',')[1];
            if (base64Data) {
                resolve(base64Data);
            } else {
                reject(new Error("Failed to extract base64 data from file."));
            }
        };
        reader.onerror = error => reject(error);
    });
};

export const fileToDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file);
    });
};

export const generateUniqueId = () => `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

export const generateSessionTitle = (messages: ChatMessage[]): string => {
    const firstUserMessage = messages.find(msg => msg.role === 'user' && msg.content.trim() !== '');
    if (firstUserMessage) {
      return firstUserMessage.content.split(/\s+/).slice(0, 7).join(' ') + (firstUserMessage.content.split(/\s+/).length > 7 ? '...' : '');
    }
    const firstModelMessage = messages.find(msg => msg.role === 'model' && msg.content.trim() !== '');
     if (firstModelMessage) {
      return "Model: " + firstModelMessage.content.split(/\s+/).slice(0, 5).join(' ') + (firstModelMessage.content.split(/\s+/).length > 5 ? '...' : '');
    }
    const firstFile = messages.find(msg => msg.files && msg.files.length > 0)?.files?.[0];
    if (firstFile) {
        return `Chat with ${firstFile.name}`;
    }
    return 'New Chat';
};

export const buildContentParts = async (
  text: string, 
  files: UploadedFile[] | undefined
): Promise<{
  contentParts: ContentPart[];
  enrichedFiles: UploadedFile[];
}> => {
  const filesToProcess = files || [];
  
  const processedResults = await Promise.all(filesToProcess.map(async (file) => {
    // Create a shallow copy to avoid direct mutation of state objects
    const newFile = { ...file };
    let part: ContentPart | null = null;

    if (file.isProcessing || file.error || file.uploadState !== 'active') {
      return { file: newFile, part };
    }
    
    if (SUPPORTED_IMAGE_MIME_TYPES.includes(file.type) && !file.fileUri) {
      let base64Data = file.base64Data;
      
      if (!base64Data) { // Only convert if not already present
        if (file.rawFile) {
          try {
            base64Data = await fileToBase64(file.rawFile);
          } catch (error) {
            logService.error(`Failed to convert rawFile to base64 for ${file.name}`, { error });
          }
        } else if (file.dataUrl?.startsWith('blob:')) {
          try {
            const response = await fetch(file.dataUrl);
            const blob = await response.blob();
            const tempFile = new File([blob], file.name, { type: file.type });
            base64Data = await fileToBase64(tempFile);
          } catch (error) {
            logService.error(`Failed to fetch blob and convert to base64 for ${file.name}`, { error });
          }
        }
      }
      
      if (base64Data) {
        newFile.base64Data = base64Data;
        part = { inlineData: { mimeType: file.type, data: base64Data } };
      }
    } else if (file.fileUri) {
      part = { fileData: { mimeType: file.type, fileUri: file.fileUri } };
    }
    
    return { file: newFile, part };
  }));

  const enrichedFiles = processedResults.map(r => r.file);
  const dataParts = processedResults.map(r => r.part).filter((p): p is ContentPart => p !== null);

  const userTypedText = text.trim();
  const contentPartsResult: ContentPart[] = [];
  if (userTypedText) {
    contentPartsResult.push({ text: userTypedText });
  }
  contentPartsResult.push(...dataParts);

  return { contentParts: contentPartsResult, enrichedFiles };
};

export const createChatHistoryForApi = async (msgs: ChatMessage[]): Promise<ChatHistoryItem[]> => {
    const historyItemsPromises = msgs
      .filter(msg => msg.role === 'user' || msg.role === 'model')
      .map(async (msg) => {
        let apiParts: ContentPart[];
        if (msg.role === 'user') {
          const { contentParts } = await buildContentParts(msg.content, msg.files);
          apiParts = contentParts;
        } else {
          apiParts = [{ text: msg.content || "" }];
        }
        return { role: msg.role as 'user' | 'model', parts: apiParts };
      });
      
    return Promise.all(historyItemsPromises);
  };

export const applyImageCachePolicy = (sessions: SavedChatSession[]): SavedChatSession[] => {
    const sessionsCopy = JSON.parse(JSON.stringify(sessions)); // Deep copy to avoid direct state mutation
    if (sessionsCopy.length > 5) {
        logService.debug('Applying image cache policy: Pruning images from sessions older than 5th.');
        // Prune images from the 6th session onwards
        for (let i = 5; i < sessionsCopy.length; i++) {
            const session = sessionsCopy[i];
            if (session.messages && Array.isArray(session.messages)) {
                session.messages.forEach((message: ChatMessage) => {
                    if (message.files && Array.isArray(message.files)) {
                        message.files.forEach((file: UploadedFile) => {
                            if (SUPPORTED_IMAGE_MIME_TYPES.includes(file.type)) {
                                if (file.dataUrl) delete file.dataUrl;
                                if (file.base64Data) delete file.base64Data;
                            }
                        });
                    }
                });
            }
        }
    }
    return sessionsCopy;
};
