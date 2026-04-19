import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import nodemailer from "nodemailer";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import firebaseConfig from "./firebase-applet-config.json";

import { getFirestore } from "firebase-admin/firestore";

try {
  // Initialize Firebase Admin
  if (!getApps().length) {
    initializeApp({
      projectId: firebaseConfig.projectId,
    });
  }
} catch (error) {
  console.error("Failed to initialize Firebase Admin:", error);
}

let firestore: any;
try {
  const app = getApps()[0];
  firestore = firebaseConfig.firestoreDatabaseId 
    ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
    : getFirestore(app);
} catch (error) {
  console.error("Failed to initialize Firestore:", error);
}

async function startServer() {
  console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode...`);
  try {
    const app = express();
    const PORT = 3000;

  app.use(express.json({ limit: '100mb' }));

  // Middleware to verify Firebase ID Token
  const authenticate = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await getAuth().verifyIdToken(idToken);
      req.user = decodedToken;
      
      // 1. Check if user is the hardcoded super-admin first
      if (decodedToken.email === "alvicourse@gmail.com") {
        return next();
      }
      
      // 2. Otherwise, check Firestore for admin role
      try {
        const userDoc = await firestore.collection('users').doc(decodedToken.uid).get();
        const userData = userDoc.data();
        
        if (userData && userData.role === 'admin') {
          return next();
        }
      } catch (fsError) {
        console.error('Firestore admin check failed:', fsError);
        // Fall through to 403 if Firestore check fails and not super-admin
      }

      res.status(403).json({ error: 'Forbidden: Admin access required' });
    } catch (error) {
      console.error('Error verifying token:', error);
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
  };

  // Cache for transporter to reuse connections
  let mailTransporter: any = null;
  let currentConfig: string = "";

  const getTransporter = (email: string, pass: string) => {
    const configKey = `${email}:${pass}`;
    if (mailTransporter && currentConfig === configKey) {
      return mailTransporter;
    }

    mailTransporter = nodemailer.createTransport({
      service: "gmail",
      pool: true, // Use connection pooling
      maxConnections: 5,
      maxMessages: 100,
      auth: {
        user: email,
        pass: pass,
      },
    });
    currentConfig = configKey;
    return mailTransporter;
  };

  // API routes
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
        details: error.message 
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
      gmailAppPassword: bodyPass
    } = req.body;

    try {
      let gmailEmail = bodyEmail;
      let gmailAppPassword = bodyPass;

      // If not provided in body, try to fetch from Firestore
      if (!gmailEmail || !gmailAppPassword) {
        try {
          const settingsDoc = await firestore.collection('siteSettings').doc('general').get();
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
            encoding: 'base64'
          }
        ];
      }

      await transporter.sendMail(mailOptions);
      res.json({ success: true, message: "Email sent successfully!" });
    } catch (error: any) {
      console.error("Error sending email:", error);
      res.status(500).json({ 
        error: "Failed to send email", 
        details: error.message 
      });
    }
  });

  app.post("/api/send-certificates-bulk", authenticate, async (req, res) => {
    const { 
      emails, // Array of { to, subject, body, attachmentBase64, fileName }
      gmailEmail: bodyEmail,
      gmailAppPassword: bodyPass
    } = req.body;

    try {
      let gmailEmail = bodyEmail;
      let gmailAppPassword = bodyPass;

      // If not provided in body, try to fetch from Firestore
      if (!gmailEmail || !gmailAppPassword) {
        try {
          const settingsDoc = await firestore.collection('siteSettings').doc('general').get();
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
      
      // Send all emails in the batch
      const results = await Promise.allSettled(emails.map(emailData => {
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
              encoding: 'base64'
            }
          ];
        }

        return transporter.sendMail(mailOptions);
      }));

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      res.json({ 
        success: true, 
        message: `Processed ${emails.length} emails. Success: ${successful}, Failed: ${failed}`,
        results: results.map(r => r.status)
      });
    } catch (error: any) {
      console.error(`Error in bulk sending:`, error);
      res.status(500).json({ 
        error: `Failed to process bulk emails`, 
        details: error.message 
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  } catch (error) {
    console.error("Failed to start server:", error);
  }
}

startServer();
