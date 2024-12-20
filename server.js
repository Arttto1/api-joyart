require("dotenv").config();

const PORT = process.env.PORT || 3001;

const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const path = require("path");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), // Corrige as quebras de linha
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};
const nodemailer = require("nodemailer");
const stripe = require("stripe")(process.env.STRIPE_PRIVATE_KEY);
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const app = express();

app.use(express.static("public"));
let imagePath = null;
let nameWithId = null;

initializeApp({
  credential: cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = getFirestore();
const storage = getStorage();

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const siteLink = process.env.SERVER_URL;

// Configurações de CORS
const corsOptions = {
  origin: [
    "https://artjoy.netlify.app",
  ],
  methods: "GET, POST, OPTIONS",
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "Stripe-Signature",
  ],
};

// Usando o middleware CORS
app.use(cors(corsOptions));

app.get("/", (req, res) => {
  res.status(200).send("Bem-vindo à API do ArtJoy!"); // Responde com status 200 e a mensagem
});


app.post("/api/upload", upload.array("files"), async (req, res) => {
  try {
    // Verifica se os dados estão presentes no req.body
    if (!req.body.data) {
      throw new Error("Dados do formulário estão faltando.");
    }

    const data = JSON.parse(req.body.data); // Parseia os dados JSON
    const { name, date, message, urlYtb, nameWithId, userEmail } = data;

    const files = req.files;
    if (!files || files.length === 0) {
      throw new Error("Nenhum arquivo foi enviado.");
    }

    const downloadURLs = [];

    // Fazendo o upload dos arquivos usando o Firebase Admin SDK
    const bucket = storage.bucket(); // Obtém o bucket
    for (const file of files) {
      const fileName = `${nameWithId}/${Date.now()}_${file.originalname}`;
      const fileBuffer = file.buffer;

      // Cria um novo arquivo no bucket
      const fileUpload = bucket.file(fileName);

      // Faz o upload do buffer do arquivo
      await fileUpload.save(fileBuffer);

      // Gera a URL de download
      const downloadURL = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${fileName}`;
      downloadURLs.push(downloadURL);
    }

    const submissionData = {
      date, // Adiciona a data
      name, // Adiciona o nome
      message, // Adiciona a mensagem
      urlYtb, // Adiciona a URL do YouTube
      userEmail,
      imagePath: nameWithId,
    };

    await db.collection("submissions").doc(nameWithId).set(submissionData);
    res
      .status(200)
      .json({ message: "Dados enviados com sucesso!", submissionData });
  } catch (error) {
    console.error("Erro ao processar upload:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/submissions/:urlName", async (req, res) => {
  try {
    const { urlName } = req.params;
    const docRef = db.collection("submissions").doc(urlName);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ error: "Documento não encontrado" });
    }

    const data = docSnap.data();
    const imagePath = data.imagePath;
    const bucket = getStorage().bucket();

    // Pegar URLs das imagens
    const [files] = await bucket.getFiles({ prefix: imagePath });

    if (!files.length) {
      return res.status(404).json({ error: "Nenhuma imagem encontrada." });
    }

    const imageUrls = await Promise.all(
      files.map(async (file) => {
        const [url] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + 1000 * 60 * 30, // URL válida por 1 hora
        });
        return url;
      })
    );

    res.json({
      ...data,
      imageUrls,
    });
  } catch (error) {
    console.error("Erro ao buscar dados:", error);
    res.status(500).json({ error: "Erro ao buscar dados" });
  }
});

const storeItems = new Map([
  [
    1,
    {
      priceInCentsUSD: 499,
      priceInCentsBRL: 1649,
      nameUS: "One year plan, 4 photos and no music",
      nameBR: " Plano de 1 ano, 4 fotos e sem música",
    },
  ],
  [
    2,
    {
      priceInCentsUSD: 949,
      priceInCentsBRL: 2999,
      nameUS: "Lifetime plan, 8 photos and with music",
      nameBR: " Plano vitalício, 8 fotos e com música",
    },
  ],
]);

const getUserCountry = async (ip) => {
  try {
    const response = await axios.get(
      `https://ipinfo.io/${ip}/geo?token=${process.env.IPINFO_TOKEN}`
    );
    return response.data.country || "US"; // Padrão: 'US'
  } catch (error) {
    console.error("Erro ao buscar a localização do IP:", error);
    return "US"; // Retorna 'US' em caso de falha
  }
};

app.get("/api/get-country", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"];
  console.log("IP do usuário:", ip); // Log do IP capturado
  const country = await getUserCountry(ip);
  console.log("País identificado:", country); // Log do país identificado
  res.json({ country });
});

app.post("/create-checkout-session", express.json(), async (req, res) => {
  const { items, nameWithId, userEmail } = req.body;
  const userIp = req.headers["x-forwarded-for"] || req.ip;

  console.log("nameWithId recebido:", nameWithId);

  try {
    // obter pais usando ip
    const userCountry = await getUserCountry(userIp);
    const isBrazil = userCountry === "BR";
    const currency = isBrazil ? "brl" : "usd";

    // criar sessão de checkout
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: items.map((item) => {
        const storeItem = storeItems.get(item.id);
        const unit_amount = isBrazil
          ? storeItem.priceInCentsBRL
          : storeItem.priceInCentsUSD;
        return {
          price_data: {
            currency: currency,
            product_data: {
              name: isBrazil ? storeItem.nameBR : storeItem.nameUS,
            },
            unit_amount: unit_amount,
          },
          quantity: item.quantity,
        };
      }),
      success_url: `${siteLink}/success.html`,
      cancel_url: `${siteLink}/cancel.html`,
      customer_creation: "always",
      metadata: {
        nameWithId: nameWithId,
        userEmail: userEmail
      },
    });
    res.json({ url: session.url });
    console.log("Sessão criada:");
  } catch (e) {
    console.error("Erro ao criar sessão de checkout:");
    res.status(500).json({ error: e.message });
    console.log("algum erro ocorreu");
  }
});

function generateQRCodeLink(link) {
  return `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
    link
  )}&size=200x200`;
}

const sendThankYouEmail = async (userEmailCheckout, nameWithIdCheckout) => {
  
  const encodedString = encodeURIComponent(nameWithIdCheckout);

  const costumerUrl = `https://artjoy.netlify.app/second.html?name=${encodedString}`;

  const qrCodeUrl = generateQRCodeLink(costumerUrl);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.AUTH_MAIL,
      pass: process.env.APP_PASS,
    },
  });

  const mailOptions = {
    from: process.env.AUTH_MAIL,
    to: userEmailCheckout,
    subject: "Thank You for Your Purchase!",
    html:     `
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Fredoka:wdth,wght@75..125,300..700&family=Quicksand:wght@300..700&display=swap"
      rel="stylesheet"
    />
    <div style="background-color: #f59eab; padding: 1.5rem; font-family: 'fredoka', sans-serif; color: #fff; text-align: center; margin: 0;">
      <h1 style="color: #d43f55; padding-bottom: 0.5rem;">Thank You for Your Purchase!</h1>
      <p style="margin-bottom: 0.5rem;">We truly appreciate your choice and trust in our service.</p>
      <p style="margin-bottom: 0.5rem;">Here is your exclusive access link:</p>
      <p style="margin-bottom: 0.5rem;"><a href="${costumerUrl}" style="color: #0e004f; font-weight: bold;">${costumerUrl}</a></p>
      <p style="margin-bottom: 0.5rem;">Or you can scan the QR code below to get instant access:</p>
      <div style="text-align: center; margin: 1.5rem 0;">
        <img src="${qrCodeUrl}" alt="QR Code" style="border-radius: 10px;"/>
      </div>
      <p style="margin-bottom: 0.5rem;">If this email is in junk folder or spam, move it to your inbox to view the QR code and access the link.</p>
      <p style="color: #0e004f; font-weight: bolder;">Thank you once again for choosing us!</p>
    </div>`
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("E-mail enviado: " + info.response);
  } catch (error) {
    console.error("Erro ao enviar o e-mail:", error);
    console.log("erro ao enviar o email");
  }
};

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      console.log("Evento recebido:");
    } catch (err) {
      console.error("Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const nameWithIdCheckout = session.metadata.nameWithId;
      const userEmailCheckout = session.metadata.userEmail;

      console.log(
        "userEmail e nameWithId recebido no webhook:",
        nameWithIdCheckout,
        userEmailCheckout
      );

      if (userEmailCheckout && nameWithIdCheckout) {
        console.log("Enviando e-mail para:", userEmailCheckout);
        try {
          await sendThankYouEmail(userEmailCheckout, nameWithIdCheckout);
          console.log("E-mail enviado com sucesso.");
        } catch (error) {
          console.error("Erro ao enviar o e-mail:", error);
        }
      }
    }

    // Retorna 200 após processar o evento
    return res.status(200).json({ received: true });
  }
);


app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
