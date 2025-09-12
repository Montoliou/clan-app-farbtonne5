// Firebase Admin SDK to access Firestore
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Firebase Functions SDK to create HTTP triggers
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

// Initialize the app with the project's default credentials
initializeApp();

const MAX_HYDRA_KEYS = 3;
const MAX_CHIMERA_KEYS = 2;

exports.updateDataFromHelper = onRequest(
  { 
    region: "europe-west3",
    cors: true 
  },
  async (req, res) => {
    logger.info("Request received", { query: req.query });

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

        // Calculate USED keys from REMAINING keys
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
  });

