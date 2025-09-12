const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");

initializeApp();

const MAX_HYDRA_KEYS = 3;
const MAX_CHIMERA_KEYS = 2;

// Helper function to get the week number
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// 1. API Function for RSL Helper
exports.updateDataFromHelper = onRequest(
  { region: "europe-west3", cors: true },
  async (req, res) => {
    logger.info("RSL Helper request received", { query: req.query });

    if (req.method === "GET") {
      const { umid, hydraKeysRemaining, chimeraKeysRemaining } = req.query;

      if (!umid) {
        logger.warn("Missing umid parameter");
        res.status(400).send("Bad Request: Missing 'umid' parameter.");
        return;
      }

      const db = getFirestore();
      const membersRef = db.collection("clans/farbtonne5/members");

      try {
        const querySnapshot = await membersRef.where("umid", "==", umid).limit(1).get();

        if (querySnapshot.empty) {
          logger.warn("No member found with umid:", umid);
          res.status(404).send(`Not Found: No member found with umid ${umid}.`);
          return;
        }

        const memberDoc = querySnapshot.docs[0];
        const dataToUpdate = {};

        if (hydraKeysRemaining !== undefined) {
          const remaining = parseInt(hydraKeysRemaining, 10);
          if (!isNaN(remaining) && remaining >= 0 && remaining <= MAX_HYDRA_KEYS) {
            dataToUpdate.hydraKeysCount = MAX_HYDRA_KEYS - remaining;
          }
        }
        if (chimeraKeysRemaining !== undefined) {
          const remaining = parseInt(chimeraKeysRemaining, 10);
          if (!isNaN(remaining) && remaining >= 0 && remaining <= MAX_CHIMERA_KEYS) {
            dataToUpdate.chimeraKeysCount = MAX_CHIMERA_KEYS - remaining;
          }
        }

        if (Object.keys(dataToUpdate).length > 0) {
          await memberDoc.ref.update(dataToUpdate);
          logger.info("Successfully updated member:", memberDoc.id, dataToUpdate);
          res.status(200).send(`OK: Member ${memberDoc.id} updated.`);
        } else {
          logger.info("No valid data to update for member:", memberDoc.id);
          res.status(200).send("OK: No valid data provided to update.");
        }
      } catch (error) {
        logger.error("Error updating member data:", error);
        res.status(500).send("Internal Server Error");
      }
    } else {
      res.status(405).send("Method Not Allowed");
    }
  }
);

// 2. Scheduled Function for Automatic Reminders
exports.scheduledReminderCheck = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Europe/Berlin",
    region: "europe-west3",
  },
  async (event) => {
    logger.log("Scheduled reminder check running...");
    const db = getFirestore();
    const settingsDocRef = doc(db, "clans/farbtonne5");
    
    try {
        const docSnap = await settingsDocRef.get();
        if (!docSnap.exists()) {
            logger.warn("Settings document not found!");
            return;
        }

        const settings = docSnap.data().settings;
        if (!settings || !settings.autoRemindersEnabled) {
            logger.info("Automatic reminders are disabled.");
            return;
        }

        const now = new Date();
        const currentWeek = getWeekNumber(now);

        await checkAndSend(db, settings, 'hydra', now, currentWeek);
        await checkAndSend(db, settings, 'chimera', now, currentWeek);

    } catch (error) {
        logger.error("Error running scheduled reminder check:", error);
    }
  }
);

async function checkAndSend(db, settings, bossType, now, currentWeek) {
    const isHydra = bossType === 'hydra';
    const schedule = isHydra ? settings.hydraReminderSchedule : settings.chimeraReminderSchedule;
    const lastSentField = isHydra ? 'lastHydraReminderSentForWeek' : 'lastChimeraReminderSentForWeek';

    if (!schedule || !schedule.time || schedule.day === undefined) {
        logger.warn(`Schedule for ${bossType} is incomplete.`);
        return;
    }
    
    const [hour, minute] = schedule.time.split(':').map(Number);
    const dayOfWeek = now.getDay();

    // JS getDay(): Sunday = 0, Monday = 1, ...
    // Our settings: Monday = 1, ..., Sunday = 0
    // So they match.

    if (dayOfWeek === schedule.day && now.getHours() === hour && now.getMinutes() >= minute) {
        if (settings[lastSentField] === currentWeek) {
            logger.info(`Reminder for ${bossType} for week ${currentWeek} has already been sent.`);
            return;
        }

        logger.info(`Time match for ${bossType} reminder. Sending...`);
        await sendDiscordReminder(db, settings, bossType, true);

        await setDoc(doc(db, "clans/farbtonne5"), {
            settings: { [lastSentField]: currentWeek }
        }, { merge: true });
    }
}

async function sendDiscordReminder(db, settings, bossType, isAutomatic) {
    const webhookUrl = settings.webhookUrl;
    if (!webhookUrl) return;

    const membersRef = collection(db, "clans/farbtonne5/members");
    const snapshot = await membersRef.get();
    const allMembers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const isHydra = bossType === 'hydra';
    const bossName = isHydra ? 'Hydra' : 'Chimäre';
    const maxKeys = isHydra ? 3 : 2;
    const keysCountField = isHydra ? 'hydraKeysCount' : 'chimeraKeysCount';
    const doneManuallyField = isHydra ? 'hydraDoneManually' : 'chimeraDoneManually';

    const today = new Date(); 
    today.setHours(0, 0, 0, 0);

    const missingKeysMembers = allMembers.filter(member => {
        const vacationStartStr = member.vacationStart;
        const vacationEndStr = member.vacationEnd;
        if (vacationStartStr && vacationEndStr) {
            const vacationStartDate = new Date(vacationStartStr);
            const vacationEndDate = new Date(vacationEndStr);
            vacationStartDate.setHours(0,0,0,0);
            vacationEndDate.setHours(0,0,0,0);
            if (today >= vacationStartDate && today <= vacationEndDate) {
                return false;
            }
        }
        
        if (member.umid) {
            return (member[keysCountField] ?? 0) < maxKeys;
        } else {
            return !member[doneManuallyField];
        }
    });

    if (missingKeysMembers.length === 0) {
        logger.info(`All members have used their ${bossName} keys.`);
        return;
    }
            
    const mentions = missingKeysMembers.filter(m => m.discordId && /^\d{17,19}$/.test(m.discordId)).map(m => `<@${m.discordId}>`);
    const namesOnly = missingKeysMembers.filter(m => !m.discordId || !/^\d{17,19}$/.test(m.discordId)).map(m => m.discordName);
    
    let content = `**Erinnerung:** Bitte die **${bossName}**-Schlüssel nutzen!\n\n`;
    if (mentions.length > 0) content += mentions.join(' ');
    if (namesOnly.length > 0) content += `\n\nOffen bei (ohne Ping): ${namesOnly.join(', ')}`;
    
    const leads = allMembers.filter(m => settings.clanLeads?.includes(m.id)).map(l => l.inGameName).join(', ');
    content += `\n\n---\n*Diese Erinnerung wurde automatisch im Namen von ${leads} gesendet.*`;

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content.trim(), username: "Clan App Bot" })
        });
        if (!response.ok) {
            throw new Error(`Server responded with status: ${response.status}`);
        }
        logger.info(`Successfully sent automatic reminder for ${bossName}.`);
    } catch (error) {
        logger.error('Error sending webhook:', error);
    }
}