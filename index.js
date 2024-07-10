const express = require("express");
const route = require("./src/routes/routes");
const cors = require("cors");
const port = process.env.PORT || 3070;
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fs = require("fs");
const util = require("util");
const path = require("path");
const exists = util.promisify(fs.access);
const unlink = util.promisify(fs.unlinkSync);
const QRCode = require("qrcode");
const { respond } = require("./src/controllers/AutoRespond");
const db = require("./src/config/db");
const { QueryTypes } = require("sequelize");
const cron = require("node-cron");
const fileUpload = require("express-fileupload");
const initModels = require("./models/init-models.js");
const { template_pesan, contact, barang, sms, schedule_wa } = initModels(db);
const moment = require("moment");
const sequelize = require("./src/config/db");

const phoneNumberFormatter = function (number) {
  // 1. Menghilangkan karakter selain angka
  let formatted = number.replace(/\D/g, "");

  // 2. Menghilangkan angka 0 di depan (prefix)
  //    Kemudian diganti dengan 62
  if (formatted.startsWith("0")) {
    formatted = "62" + formatted.substr(1);
  }

  if (!formatted.endsWith("@c.us")) {
    formatted += "@c.us";
  }

  return formatted;
};

function fileExists(path) {
  return new Promise((resolve, reject) => {
    exists(path, fs.F_OK)
      .then((ok) => {
        resolve(true);
      })
      .catch((err) => {
        resolve(false);
      });
  });
}

global.client = new Client({
  authStrategy: new LocalAuth(),
  restartOnAuthFail: true,
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process", // <- this one doesn't works in Windows
      "--disable-gpu",
    ],
  },
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use("/upload", express.static("upload"));
app.use(
  fileUpload({
    debug: false,
  })
);

global.client.on("authenticated", async (session) => {
  console.log("authenticated");
  const filename = path.join(process.cwd(), "upload/qr.png");
  const isExist = await fileExists(filename);
  if (isExist) {
    await unlink(filename);
  }
});

client.on("qr", async (qr) => {
  // console.log("qr");

  const filename = path.join(process.cwd(), "upload/qr.png");

  const toFileSync = util.promisify(QRCode.toFile);
  await toFileSync(filename, qr, { width: 300, height: 300 }, (err) => {
    if (err) throw err;
    console.log("success create qr file");
  });
});

client.on("auth_failure", () => {
  console.log("AUTH Failed !");
});

client.on("ready", () => {
  console.log("Client is ready!");

  // ini changes tgl 9juli untuk fitur cron check scheduled message

  cron.schedule("* * * * *", async () => {
    const templateScheduled = await db.query(
      `SELECT date(NOW()) AS tgl_server, s.*, t.title, t.body, t.image 
FROM schedule_wa s
INNER JOIN template_pesan t ON s.id_template_pesan = t.id
WHERE  (date(NOW()) 
	BETWEEN s.tanggal_awal AND s.tanggal_akhir)
	AND (IFNULL(s.tgl_eksekusi,(date(NOW()))+1) <> (date(NOW()))) 
	AND s.status='Y';`,
      { type: QueryTypes.SELECT }
    );

    // console.log(templateScheduled, "apakah ada isin");

    const listUsers = await db.query(
      `SELECT c.urut, c.nomor, c.nama
FROM contact c
WHERE c.status_member = 'Y';`,
      { type: QueryTypes.SELECT }
    );

    const convertNumber = (number) => {
      // console.log(number);
      let result = "";
      if (number[0] === "0") {
        result = "62" + number.substring(1);
      } else if (number[0] === "+") {
        result = number.substring(1);
      } else {
        result = "62" + number;
      }
      // console.log(result);
      return result;
    };

    templateScheduled?.map(async (template) => {
      listUsers?.map(async (user) => {
        await client.sendMessage(
          convertNumber(user?.nomor) + "@c.us",
          template?.body
        );
        // console.log(
        //   "data kekirim ke",
        //   convertNumber(user?.nomor) + "@c.us",
        //   "dengan body",
        //   template?.body
        // );
      });
      await schedule_wa.update(
        {
          tgl_eksekusi: moment().format("YYYY-MM-DD"),
        },
        {
          where: {
            id: template?.id,
          },
          raw: true,
        }
      );
    });

    // akhir code scheduled message

    // console.log("running a task every minute", schculedTime);
  });
});

  client.on("loading_screen", (percent, message) => {
  console.log("LOADING SCREEN", percent, message);
  // console.log(client.getState(), "currenct state apa isinya");
});

client.on("change_state", (v) => {
  // console.log(v, "state!");
});

client.on("message_create", async (msg) => {
  // Fired on all message creations, including your own
  if (msg.fromMe) {
    return await sms.create(
      {
        id_user: 0,
        pengirim:
          "0" + msg.to.split("@")[0].substring(2, msg.to.split("@")[0].length),
        tanggal: moment().format("YYYY-MM-DD HH:mm:ss"),
        jam: moment().format("HH:mm"),
        isi: msg.body,
        jenis: "Outbox",
        icon: 1,
      },
      { raw: true }
    );
  }
});

client.on("message", async (msg) => {
  if (msg.from.slice(-4, -3) === "g") {
    return;
  }
  if (msg.from.includes("status")) {
    return;
  }

  await sms.create(
    {
      id_user: 0,
      pengirim:
        "0" +
        msg.from.split("@")[0].substring(2, msg.from.split("@")[0].length),
      tanggal: moment().format("YYYY-MM-DD HH:mm:ss"),
      jam: moment().format("HH:mm"),
      isi: msg.body,
      jenis: "Inbox",
    },
    { raw: true }
  );

  await respond(client, msg.from, msg.body, fileExists);

  console.log("CHATBOT :", msg.from);
});

client.on("disconnected", () => {
  console.log("disconnected");
  client.destroy();
  client.initialize();
});

client.initialize();

app.use("/api/v1/", route);
app.get("/", async (req, res) => {
  const query = await db.query(`SELECT now()`, { type: QueryTypes.SELECT });
  res.send(query);
});

app.post("/send-image", async (req, res) => {
  try {
    const { body } = req;
    const { data, image, message } = body;

    // const image = files.image;
    // const pathFile = __dirname + "/files/" + file.name;
    const pathFile = path.join(process.cwd(), "upload/" + image);
    // image.mv(pathFile, (err) => {
    //   if (err) {
    //     return console.log(err);
    //   }

    //   console.log("sukses");
    // });

    const media = MessageMedia.fromFilePath(pathFile);

    await Promise.all(
      data.map(async (item) => {
        const sendChat = await client.sendMessage(
          phoneNumberFormatter(item.to),
          media,
          {
            caption: message,
          }
        );
        // console.log(sendChat);
      })
    );

    res.status(200).json({
      status: true,
      message: "Sukses terkirim",
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      message: error.message,
    });
  }
});

app.post("/upload-image", async (req, res) => {
  const { body, files } = req;

  const image = files.file;

  // const pathFile = __dirname + "/files/" + file.name;
  const pathFile = path.join(process.cwd(), "upload/" + image.name);
  image.mv(pathFile, (err) => {
    if (err) {
      res.status(500).json({
        status: false,
        message: err,
      });
      return console.log(err);
    }

    // console.log("sukses");
    res.status(200).json({
      status: true,
      message: "Sukses upload",
    });
  });
});

app.listen(port, async () => {
  try {
    console.log("Server is running on port " + port);
  } catch (error) {
    console.log(error);
  }
});
