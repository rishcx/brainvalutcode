// Decides the reply language in CODE. Leaving it to a small model ("Hinglish in, Hinglish out") made it answer
// plain English questions in Hinglish. English is the default; Hinglish/Hindi only when the message clearly is.
const HINGLISH = new Set(
  ("hai hain hoon ho tha thi kya kyu kyun kaise kaha kahan kab kaun kitna kitne mujhe mujhko mera meri mere tum tumhara aap aapka " +
    "karo kar karna kardo karde krdo kijiye batao bata bolo dikhao dikha chahiye nahi nahin haan acha accha theek thik " +
    "kal aaj abhi baad pehle subah shaam raat baje ghante din yaad dilana dila dilao bhej bhejo aur lekin par bhi sab kuch koi")
    .split(" "),
);

export type ReplyLanguage = "English" | "Hinglish" | "Hindi";

export function replyLanguage(message: string): ReplyLanguage {
  if (/[ऀ-ॿ]/.test(message)) return "Hindi";
  const words = message.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length === 0) return "English";
  const hits = words.filter((w) => HINGLISH.has(w)).length;
  return hits >= 2 || (hits >= 1 && words.length <= 3) ? "Hinglish" : "English";
}
