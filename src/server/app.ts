import express, { type Express } from "express";
import nodemailer from "nodemailer";
import { cert, initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import firebaseConfig from "../../firebase-applet-config.json";

function initFirebaseAdmin() {
  if (getApps().length) return;

  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saRaw) {
    const jsonStr = saRaw.trim().startsWith("{")
      ? saRaw
      : Buffer.from(saRaw, "base64").toString("utf-8");
    const sa = JSON.parse(jsonStr);
    initializeApp({
      credential: cert(sa),
      projectId: sa.project_id || firebaseConfig.projectId,
    });
  } else {
    initializeApp({ projectId: firebaseConfig.projectId });
  }
}

export function createApp(): Express {
  try {
    initFirebaseAdmin();
  } catch (error) {
    console.error("Failed to initialize Firebase Admin:", error);
  }

  let firestore: any;
  try {
    const fbApp = getApps()[0];
    firestore = firebaseConfig.firestoreDatabaseId
      ? getFirestore(fbApp, firebaseConfig.firestoreDatabaseId)
      : getFirestore(fbApp);
  } catch (error) {
    console.error("Failed to initialize Firestore:", error);
  }

  const app = express();
  app.use(express.json({ limit: "100mb" }));

  const authenticate = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    try {
      const decodedToken = await getAuth().verifyIdToken(idToken);
      req.user = decodedToken;

      if (decodedToken.email === "alvicourse@gmail.com") {
        return next();
      }

      try {
        const userDoc = await firestore.collection("users").doc(decodedToken.uid).get();
        const userData = userDoc.data();

        if (userData && userData.role === "admin") {
          return next();
        }
      } catch (fsError) {
        console.error("Firestore admin check failed:", fsError);
      }

      res.status(403).json({ error: "Forbidden: Admin access required" });
    } catch (error) {
      console.error("Error verifying token:", error);
      res.status(401).json({ error: "Unauthorized: Invalid token" });
    }
  };

  let mailTransporter: any = null;
  let currentConfig: string = "";

  const getTransporter = (email: string, pass: string) => {
    const configKey = `${email}:${pass}`;
    if (mailTransporter && currentConfig === configKey) {
      return mailTransporter;
    }

    mailTransporter = nodemailer.createTransport({
      service: "gmail",
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      auth: { user: email, pass },
    });
    currentConfig = configKey;
    return mailTransporter;
  };

  app.post("/api/send-test-email", authenticate, async (req, res) => {
    const { email, appPassword, testRecipient } = req.body;

    if (!email || !appPassword || !testRecipient) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const transporter = getTransporter(email, appPassword);

      await transporter.sendMail({
        from: email,
        to: testRecipient,
        subject: "Seminar OS - Test Email Connection",
        text: "This is a test email to verify your Gmail connection settings in Seminar OS. If you received this, your configuration is correct!",
        html: "<b>This is a test email to verify your Gmail connection settings in Seminar OS.</b><p>If you received this, your configuration is correct!</p>",
      });

      res.json({ success: true, message: "Test email sent successfully!" });
    } catch (error: any) {
      console.error("Error sending test email:", error);
      res.status(500).json({
        error: "Failed to send test email",
        details: error.message,
      });
    }
  });

  app.post("/api/send-certificate", authenticate, async (req, res) => {
    const {
      to,
      subject,
      body,
      attachmentBase64,
      fileName,
      gmailEmail: bodyEmail,
      gmailAppPassword: bodyPass,
    } = req.body;

    try {
      let gmailEmail = bodyEmail;
      let gmailAppPassword = bodyPass;

      if (!gmailEmail || !gmailAppPassword) {
        try {
          const settingsDoc = await firestore.collection("siteSettings").doc("general").get();
          const settings = settingsDoc.data();
          if (settings) {
            gmailEmail = gmailEmail || settings.gmailEmail;
            gmailAppPassword = gmailAppPassword || settings.gmailAppPassword;
          }
        } catch (fsError) {
          console.error("Failed to fetch settings from Firestore:", fsError);
        }
      }

      if (!gmailEmail || !gmailAppPassword) {
        return res.status(500).json({ error: "Gmail credentials not configured" });
      }

      if (!to || !subject || !body) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const transporter = getTransporter(gmailEmail, gmailAppPassword);

      const mailOptions: any = {
        from: gmailEmail,
        to,
        subject,
        text: body,
      };

      if (attachmentBase64) {
        mailOptions.attachments = [
          {
            filename: fileName || "certificate.pdf",
            content: attachmentBase64.includes("base64,")
              ? attachmentBase64.split("base64,")[1]
              : attachmentBase64,
            encoding: "base64",
          },
        ];
      }

      await transporter.sendMail(mailOptions);
      res.json({ success: true, message: "Email sent successfully!" });
    } catch (error: any) {
      console.error("Error sending email:", error);
      res.status(500).json({
        error: "Failed to send email",
        details: error.message,
      });
    }
  });

  app.post("/api/send-certificates-bulk", authenticate, async (req, res) => {
    const {
      emails,
      gmailEmail: bodyEmail,
      gmailAppPassword: bodyPass,
    } = req.body;

    try {
      let gmailEmail = bodyEmail;
      let gmailAppPassword = bodyPass;

      if (!gmailEmail || !gmailAppPassword) {
        try {
          const settingsDoc = await firestore.collection("siteSettings").doc("general").get();
          const settings = settingsDoc.data();
          if (settings) {
            gmailEmail = gmailEmail || settings.gmailEmail;
            gmailAppPassword = gmailAppPassword || settings.gmailAppPassword;
          }
        } catch (fsError) {
          console.error("Failed to fetch settings from Firestore:", fsError);
        }
      }

      if (!gmailEmail || !gmailAppPassword) {
        return res.status(500).json({ error: "Gmail credentials not configured" });
      }

      if (!emails || !Array.isArray(emails)) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const transporter = getTransporter(gmailEmail, gmailAppPassword);

      const results = await Promise.allSettled(
        emails.map((emailData) => {
          const mailOptions: any = {
            from: gmailEmail,
            to: emailData.to,
            subject: emailData.subject,
            text: emailData.body,
          };

          if (emailData.attachmentBase64) {
            mailOptions.attachments = [
              {
                filename: emailData.fileName || "certificate.pdf",
                content: emailData.attachmentBase64.includes("base64,")
                  ? emailData.attachmentBase64.split("base64,")[1]
                  : emailData.attachmentBase64,
                encoding: "base64",
              },
            ];
          }

          return transporter.sendMail(mailOptions);
        })
      );

      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      res.json({
        success: true,
        message: `Processed ${emails.length} emails. Success: ${successful}, Failed: ${failed}`,
        results: results.map((r) => r.status),
      });
    } catch (error: any) {
      console.error(`Error in bulk sending:`, error);
      res.status(500).json({
        error: `Failed to process bulk emails`,
        details: error.message,
      });
    }
  });

  return app;
}
