from pymongo import MongoClient

client = MongoClient("mongodb+srv://Delger:delger123@cluster0.xvw5d.mongodb.net/mine_safety?appName=Cluster0", serverSelectionTimeoutMS=5000)
try:
    print(client.admin.command("ping"))   # {'ok': 1.0} = working
    db = client["mine_safety"]
    print(db.notifications.count_documents({}))
except Exception as e:
    print("Connection failed:", e)