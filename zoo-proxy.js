const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const readline = require("readline");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const { HttpsProxyAgent } = require("https-proxy-agent");
const user_agents = require("./config/userAgents");
const settings = require("./config/config");
const { sleep, loadData, getRandomNumber } = require("./utils");
const { checkBaseUrl } = require("./checkAPI");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

class ZooAPIClient {
  constructor(queryId, accountIndex, proxy, baseURL) {
    this.headers = {
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
      "Content-Type": "application/json",
      Origin: "https://game.zoo.team",
      Referer: "https://game.zoo.team/",
      "Sec-Ch-Ua": '"Not/A)Brand";v="99", "Google Chrome";v="115", "Chromium";v="115"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      "Is-Beta-Server": "null",
    };
    this.cachedData = null;
    this.proxyList = [];
    this.loadProxies();
    this.session_user_agents = this.#load_session_data();
    this.baseURL = baseURL;
    this.queryId = queryId;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
  }
  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    this.log(`Tแบกo user agent...`);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `"Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }
  createUserAgent() {
    try {
      const telegramauth = this.queryId;
      const userData = JSON.parse(decodeURIComponent(telegramauth.split("user=")[1].split("&")[0]));
      this.session_name = userData.id;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent, try get new query_id: ${error.message}`, "error");
      return;
    }
  }

  loadProxies() {
    try {
      const proxyFile = path.join(__dirname, "proxy.txt");
      if (fs.existsSync(proxyFile)) {
        this.proxyList = fs.readFileSync(proxyFile, "utf8").replace(/\r/g, "").split("\n").filter(Boolean);
      }
    } catch (error) {
      this.log("Error loading proxies: " + error.message, "error");
    }
  }

  async checkProxyIP(proxy) {
    try {
      const proxyAgent = new HttpsProxyAgent(proxy);
      const response = await axios.get("https://api.ipify.org?format=json", {
        httpsAgent: proxyAgent,
        timeout: 10000,
      });
      if (response.status === 200) {
        return response.data.ip;
      } else {
        throw new Error(`Unable to check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error when checking proxy IP: ${error.message}`);
    }
  }

  getAxiosConfig(index) {
    if (this.proxyList.length > 0 && index < this.proxyList.length) {
      return {
        httpsAgent: new HttpsProxyAgent(this.proxyList[index]),
        timeout: 30000,
      };
    }
    return { timeout: 30000 };
  }

  async createApiHash(timestamp, data) {
    const combinedData = `${timestamp}_${data}`;
    const encodedData = encodeURIComponent(combinedData);
    return crypto.createHash("md5").update(encodedData).digest("hex");
  }

  async login(initData, accountIndex) {
    if (!initData) {
      return { success: false, error: "initData is required" };
    }

    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const userData = JSON.parse(decodeURIComponent(initData.split("user=")[1].split("&")[0]));
      const startParam = initData.split("start_param=")[1]?.split("&")[0] || "";
      const chatInstance = initData.split("chat_instance=")[1]?.split("&")[0] || "";

      const payload = {
        data: {
          initData: initData,
          startParam: startParam,
          photoUrl: userData.photo_url || "",
          platform: "android",
          chatId: "",
          chatType: "channel",
          chatInstance: chatInstance,
        },
      };

      const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));
      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(`${this.baseURL}/telegram/auth`, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });

      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async finishOnboarding(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const payload = { data: 1 };
      const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(`${this.baseURL}/hero/onboarding/finish`, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });

      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getUserData(initData, accountIndex) {
    if (!initData) {
      return { success: false, error: "initData is required" };
    }

    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const dataPayload = JSON.stringify({ data: {} });
      const apiHash = await this.createApiHash(currentTime, dataPayload);

      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(
        `${this.baseURL}/user/data/all`,
        { data: {} },
        {
          headers,
          ...this.getAxiosConfig(accountIndex),
        }
      );

      if (response.status === 200 && response.data.success) {
        this.cachedData = response.data.data;
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getUserDataAfter(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const dataPayload = JSON.stringify({ data: {} });
      const apiHash = await this.createApiHash(currentTime, dataPayload);

      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(
        `${this.baseURL}/user/data/after`,
        { data: {} },
        {
          headers,
          ...this.getAxiosConfig(accountIndex),
        }
      );

      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async claimDailyReward(initData, rewardIndex, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const payload = { data: rewardIndex };
      const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

      const headers = {
        ...this.headers,
        "api-hash": apiHash,
        "Api-Key": hash,
        "Api-Time": currentTime,
      };

      const response = await axios.post(`${this.baseURL}/quests/daily/claim`, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });

      if (response.status === 200 && response.data.success) {
        return { success: true, data: response.data.data };
      } else {
        return { success: false, error: response.data.message };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async AnswerDaily(hash, accountIndex, questKey, checkData) {
    const url = `${this.baseURL}/quests/check`;
    const currentTime = Math.floor(Date.now() / 1000);
    const payload = { data: [questKey, checkData] };
    const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

    const headers = {
      ...this.headers,
      "api-hash": `${apiHash}`,
      "Api-Key": `${hash}`,
      "Api-Time": `${currentTime}`,
    };

    try {
      const response = await axios.post(url, payload, { headers, ...this.getAxiosConfig(accountIndex) });
      if (response.status === 200 && response.data.success) {
        return await this.claimQuest(hash, accountIndex, questKey, checkData);
      } else {
        this.log(`Kiแปm tra nhiแปm vแปฅ "${questKey}" thแบฅt bแบกi: ${response.data.error}`, "warning");
        return { success: false, error: response.data.error };
      }
    } catch (error) {
      this.log(`Lแป—i khi kiแปm tra nhiแปm vแปฅ "${questKey}": ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  }

  async claimQuest(hash, accountIndex, questKey, checkData = null) {
    const payload = { data: [questKey, checkData] };
    const currentTime = Math.floor(Date.now() / 1000);
    const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));
    const url = `${this.baseURL}/quests/claim`;
    const headers = {
      ...this.headers,
      "api-hash": `${apiHash}`,
      "Api-Key": `${hash}`,
      "Api-Time": `${currentTime}`,
    };

    try {
      const response = await axios.post(url, payload, {
        headers,
        ...this.getAxiosConfig(accountIndex),
      });
      if (response.status === 200 && response.data.success) {
        this.log(`Claim quest "${questKey}" successfully, receive reward.`, "success");
        return { success: true, data: response.data };
      } else {
        return { success: false, error: response.data.error };
      }
    } catch (error) {
      this.log(`Error when claiming quest"${questKey}": ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  }

  async completeAllQuests(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }
      const userDataResult = await this.getUserData(initData, accountIndex);
      if (!userDataResult.success) {
        throw new Error(`Failed to get user data: ${userDataResult.error}`);
      }
      const { dbData } = userDataResult.data;
      const quests = dbData.dbQuests.filter((q) => !settings.SKIP_TASKS.includes(q.key));
      for (const quest of quests) {
        if (quest.checkType === "donate_ton" || quest.checkType === "invite" || quest.checkType === "username" || quest.checkType === "ton_wallet_transaction") {
          continue;
        }
        if (quest.checkType === "checkCode") {
          this.log(`Start answering daily questions...`, "custom");
          await this.AnswerDaily(hash, accountIndex, quest.key, quest.checkData);
          continue; continue;
        }
        const claimResult = await this.claimQuest(hash, accountIndex, quest.key);
        if (claimResult.success === true) {
          this.log(`Complete quest ${quest.key} | "${quest.title}", receive ${quest.reward} reward.`, "success");
        } else if (claimResult.error === "already rewarded") {
          this.log(`Quest ${quest.key} "${quest.title}" has been completed previously.`, "warning");
        } else {
          this.log(`Cannot complete or need to do manually quest ${quest.key} | "${quest.title}": ${claimResult.error}`, "warning");
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      this.log(`Error getting task list: ${error.message}`, "error");
    }
  }

  async handleAutoFeed(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const userDataResult = await this.getUserData(initData, accountIndex);
      if (!userDataResult.success) {
        throw new Error(`Failed to get user data: ${userDataResult.error}`);
      }

      const { hero, feed } = userDataResult.data;

      if (feed.isNeedFeed) {
        if (!hero.onboarding.includes("20")) {
          const currentTime = Math.floor(Date.now() / 1000);
          const payload = { data: 20 };
          const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

          const headers = {
            ...this.headers,
            "api-hash": apiHash,
            "Api-Key": hash,
            "Api-Time": currentTime,
          };

          const onboardingResponse = await axios.post(`${this.baseURL}/hero/onboarding/finish`, payload, {
            headers,
            ...this.getAxiosConfig(accountIndex),
          });

          if (!onboardingResponse.data.success) {
            throw new Error("Failed to complete onboarding step 20");
          }
        }

        const currentTime = Math.floor(Date.now() / 1000);
        const feedPayload = { data: "instant" };
        const apiHash = await this.createApiHash(currentTime, JSON.stringify(feedPayload));

        const headers = {
          ...this.headers,
          "api-hash": apiHash,
          "Api-Key": hash,
          "Api-Time": currentTime,
        };

        const feedResponse = await axios.post(`${this.baseURL}/autofeed/buy`, feedPayload, {
          headers,
          ...this.getAxiosConfig(accountIndex),
        });

        if (feedResponse.data.success) {
          this.log("Feed the animals successfully", "success");
          return { success: true, data: feedResponse.data };
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async buyOrUpgradeAnimals(initData, accountIndex) {
    try {
      const hash = initData.split("hash=")[1]?.split("&")[0];
      if (!hash) {
        throw new Error("Could not extract hash from initData");
      }

      const userDataResult = await this.getUserData(initData, accountIndex);
      if (!userDataResult.success) {
        throw new Error(`Failed to get user data: ${userDataResult.error}`);
      }

      const { animals, hero, dbData } = userDataResult.data;
      const existingKeys = new Set(animals.map((animal) => animal.key));
      const usedPositions = new Set(animals.map((animal) => animal.position));

      if (settings.AUTO_BUY_ANIMAL) {
        for (const dbAnimal of dbData.dbAnimals) {
          if (!existingKeys.has(dbAnimal.key)) {
            const level1Price = dbAnimal.levels[0].price;

            if (hero.coins >= level1Price) {
              let position = 1;
              while (usedPositions.has(position)) {
                position++;
              }

              const currentTime = Math.floor(Date.now() / 1000);
              const payload = { data: { position, animalKey: dbAnimal.key } };
              const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

              const headers = {
                ...this.headers,
                "api-hash": apiHash,
                "Api-Key": hash,
                "Api-Time": currentTime,
              };

              const response = await axios.post(`${this.baseURL}/animal/buy`, payload, {
                headers,
                ...this.getAxiosConfig(accountIndex),
              });

              if (response.status === 200 && response.data.success) {
                this.log(`Buy successfully${dbAnimal.title}`, "success");
                usedPositions.add(position);
                existingKeys.add(dbAnimal.key);
              }
            }
          }
        }
      }
      if (settings.AUTO_UPGRADE_ANIMAL) {
        for (const animal of animals) {
          const dbAnimal = dbData.dbAnimals.find((dba) => dba.key === animal.key);
          if (dbAnimal) {
            if (animal.level >= settings.MAX_LEVEL_UPGRADE_ANIMAL) continue;
            const nextLevel = animal.level + 1;
            const nextLevelData = dbAnimal.levels.find((l) => l.level === nextLevel);

            if (nextLevelData && hero.coins >= nextLevelData.price) {
              const currentTime = Math.floor(Date.now() / 1000);
              const payload = { data: { position: animal.position, animalKey: animal.key } };
              const apiHash = await this.createApiHash(currentTime, JSON.stringify(payload));

              const headers = {
                ...this.headers,
                "api-hash": apiHash,
                "Api-Key": hash,
                "Api-Time": currentTime,
              };

              try {
                const response = await axios.post(`${this.baseURL}/animal/buy`, payload, {
                  headers,
               
