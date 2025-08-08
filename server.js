// server.js - Workshop Blockchain WebSocket Server
// The server handles:
/**
 * Participant mngt: Users and miners login with nicknames
 * Tx system: Users send tokens to each other
 * Mining system: Miners are picked randomly to mine txs, create blocks
 * Blockchain: Real blocks with merkle trees: Using sha256 hash
 * Live updates: Websocket broadcastes to all clients
 * Users spend tokens, miners earn the gas fees
 */
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto-js');

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = socketIo(server);


app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/basics', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'basics.html'));
});

app.get('/learn', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'learn.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/user', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

app.get('/miner', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'miner.html'));
});

// Workshop State
const workshopState = {
    participants: new Map(), // socketId -> participant data
    mempool: [],            // pending transactions
    blockchain: [],         // mined blocks
    currentMiner: null,     // currently selected miner
    nextMiningTime: null,   // when next mining round starts
    stats: {
        totalTransactions: 0,
        totalBlocks: 0,
        activeUsers: 0,
        activeMiners: 0
    }
};

function initializeBlockchain() {
    const genesisBlock = {
        number: 0,
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        merkleRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        timestamp: Date.now(),
        transactions: [],
        miner: 'Genesis',
        hash: 'genesis_block_hash_0000000000000000000000000000000000000000000000'
    };
    
    workshopState.blockchain.push(genesisBlock);
    console.log('🌱 Genesis block created');
}

// Utility functions
function generateTransactionHash(transaction) {
    const data = `${transaction.from}:${transaction.to}:${transaction.amount}:${transaction.fee}:${transaction.timestamp}`;
    return crypto.SHA256(data).toString();
}

function generateBlockHash(block) {
    const data = `${block.previousHash}:${block.merkleRoot}:${block.timestamp}:${block.number}`;
    return crypto.SHA256(data).toString();
}

function buildMerkleTree(txHashes) {
    if (txHashes.length === 0) return '0000000000000000000000000000000000000000000000000000000000000000';
    if (txHashes.length === 1) return txHashes[0];
    
    let currentLevel = [...txHashes];
    
    while (currentLevel.length > 1) {
        const nextLevel = [];
        
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = currentLevel[i + 1] || left; // Duplicate if odd number
            const combined = crypto.SHA256(left + right).toString();
            nextLevel.push(combined);
        }
        
        currentLevel = nextLevel;
    }
    
    return currentLevel[0];
}

function getRandomMiner() {
    const miners = Array.from(workshopState.participants.values())
        .filter(p => p.role === 'miner' && p.online);
    
    if (miners.length === 0) return null;
    
    const randomIndex = Math.floor(Math.random() * miners.length);
    return miners[randomIndex];
}

function updateStats() {
    const participants = Array.from(workshopState.participants.values());
    workshopState.stats.activeUsers = participants.filter(p => p.role === 'user' && p.online).length;
    workshopState.stats.activeMiners = participants.filter(p => p.role === 'miner' && p.online).length;
}

function broadcastToAll(event, data) {
    io.emit(event, data);
}

// WebSocket Connection Handler
io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);
    
    // Handle participant joining
    socket.on('join-workshop', (data) => {
        const { nickname, role } = data;
        
        // Check if nickname is already taken
        const existingParticipant = Array.from(workshopState.participants.values())
            .find(p => p.nickname === nickname && p.online);
        
        if (existingParticipant) {
            socket.emit('join-error', { message: 'Nickname already taken!' });
            return;
        }
        
        // Create participant
        const participant = {
            id: socket.id,
            nickname,
            role, 
            balance: role === 'user' ? 100 : 0, 
            miningRewards: role === 'miner' ? 0 : null,
            blocksMined: role === 'miner' ? 0 : null,
            online: true,
            joinedAt: Date.now()
        };
        
        workshopState.participants.set(socket.id, participant);
        updateStats();
        
        console.log(`👤 ${nickname} joined as ${role}`);
        
        socket.emit('join-success', {
            participant,
            mempool: workshopState.mempool,
            blockchain: workshopState.blockchain,
            stats: workshopState.stats,
            participants: Array.from(workshopState.participants.values())
        });
        
        broadcastToAll('participant-joined', {
            participant,
            stats: workshopState.stats,
            participants: Array.from(workshopState.participants.values())
        });
    });
    
    // Handle transaction sending
    socket.on('send-transaction', (data) => {
        const { to, amount, fee } = data;
        const sender = workshopState.participants.get(socket.id);
        
        if (!sender || sender.role !== 'user') {
            socket.emit('transaction-error', { message: 'Only users can send transactions!' });
            return;
        }
        
        // Check if sender has enough balance
        if (sender.balance < (amount + fee)) {
            socket.emit('transaction-error', { message: 'Insufficient balance!' });
            return;
        }
        
        // Check if recipient exists
        const recipient = Array.from(workshopState.participants.values())
            .find(p => p.nickname === to && p.online);
        
        if (!recipient) {
            socket.emit('transaction-error', { message: 'Recipient not found!' });
            return;
        }
        
        // Create transaction
        const transaction = {
            id: Date.now() + Math.random(),
            from: sender.nickname,
            to: recipient.nickname,
            amount: parseFloat(amount),
            fee: parseFloat(fee),
            timestamp: Date.now(),
            hash: null
        };
        
        // Generate transaction hash
        transaction.hash = generateTransactionHash(transaction);
        
        // Add to mempool (max 5 transactions per block)
        if (workshopState.mempool.length >= 5) {
            socket.emit('transaction-error', { message: 'Mempool is full! Wait for next block.' });
            return;
        }
        
        workshopState.mempool.push(transaction);
        workshopState.stats.totalTransactions++;
        
        // Update sender balance (deduct amount + fee)
        sender.balance -= (transaction.amount + transaction.fee);
        
        console.log(`💸 Transaction: ${sender.nickname} → ${recipient.nickname} (${amount} tokens)`);
        
        // Broadcast new transaction
        broadcastToAll('new-transaction', {
            transaction,
            mempool: workshopState.mempool,
            stats: workshopState.stats,
            participants: Array.from(workshopState.participants.values())
        });
        
        // Check if we should trigger mining (3+ transactions or every 30 seconds)
        if (workshopState.mempool.length >= 3) {
            triggerMining();
        }
    });
    
    // Handle mining
    socket.on('mine-block', (data) => {
        const miner = workshopState.participants.get(socket.id);
        
        if (!miner || miner.role !== 'miner') {
            socket.emit('mining-error', { message: 'Only miners can mine blocks!' });
            return;
        }
        
        if (workshopState.currentMiner !== miner.nickname) {
            socket.emit('mining-error', { message: 'Not your turn to mine!' });
            return;
        }
        
        if (workshopState.mempool.length === 0) {
            socket.emit('mining-error', { message: 'No transactions to mine!' });
            return;
        }
        
        // Get transactions for this block (max 5)
        const transactionsToMine = workshopState.mempool.splice(0, 5);
        const txHashes = transactionsToMine.map(tx => tx.hash);
        const merkleRoot = buildMerkleTree(txHashes);
        
        // Get previous block hash
        const previousBlock = workshopState.blockchain[workshopState.blockchain.length - 1];
        const previousHash = previousBlock ? previousBlock.hash : '0000000000000000000000000000000000000000000000000000000000000000';
        
        // Create new block
        const newBlock = {
            number: workshopState.blockchain.length,
            previousHash,
            merkleRoot,
            timestamp: Date.now(),
            transactions: transactionsToMine,
            miner: miner.nickname,
            hash: null
        };
        
        // Generate block hash
        newBlock.hash = generateBlockHash(newBlock);
        
        // Add to blockchain
        workshopState.blockchain.push(newBlock);
        workshopState.stats.totalBlocks++;
        
        // Process transactions (update recipient balances)
        transactionsToMine.forEach(tx => {
            const recipient = Array.from(workshopState.participants.values())
                .find(p => p.nickname === tx.to);
            if (recipient) {
                recipient.balance += tx.amount;
            }
        });
        
        // Reward miner with transaction fees
        const totalFees = transactionsToMine.reduce((sum, tx) => sum + tx.fee, 0);
        miner.miningRewards += totalFees;
        miner.blocksMined++;
        
        console.log(`⛏️ Block #${newBlock.number} mined by ${miner.nickname} (${totalFees} tokens earned)`);
        
        // Clear current miner
        workshopState.currentMiner = null;
        
        // Broadcast block mined
        broadcastToAll('block-mined', {
            block: newBlock,
            blockchain: workshopState.blockchain,
            mempool: workshopState.mempool,
            stats: workshopState.stats,
            participants: Array.from(workshopState.participants.values())
        });
        
        // Schedule next mining round if mempool has transactions
        if (workshopState.mempool.length > 0) {
            setTimeout(() => triggerMining(), 5000); // Wait 5 seconds before next round
        }
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        const participant = workshopState.participants.get(socket.id);
        if (participant) {
            participant.online = false;
            console.log(`👋 ${participant.nickname} disconnected`);
            
            updateStats();
            broadcastToAll('participant-left', {
                participant,
                stats: workshopState.stats,
                participants: Array.from(workshopState.participants.values())
            });
        }
    });
});

// Mining trigger function
function triggerMining() {
    if (workshopState.currentMiner) return; // Mining already in progress
    
    const availableMiner = getRandomMiner();
    if (!availableMiner) {
        console.log('⚠️ No miners available!');
        return;
    }
    
    workshopState.currentMiner = availableMiner.nickname;
    workshopState.nextMiningTime = Date.now() + 30000; // 30 seconds to mine
    
    console.log(`🎯 ${availableMiner.nickname} selected to mine next block`);
    
    // Broadcast miner selection
    broadcastToAll('miner-selected', {
        miner: availableMiner.nickname,
        blockNumber: workshopState.blockchain.length,
        pendingTransactions: workshopState.mempool.length,
        deadline: workshopState.nextMiningTime
    });
    
    // Auto-trigger if miner doesn't mine within 30 seconds
    setTimeout(() => {
        if (workshopState.currentMiner === availableMiner.nickname) {
            console.log(`⏰ ${availableMiner.nickname} missed their mining opportunity`);
            workshopState.currentMiner = null;
            if (workshopState.mempool.length > 0) {
                triggerMining(); // Try next miner
            }
        }
    }, 30000);
}

// Auto-trigger mining every 45 seconds if mempool has transactions
setInterval(() => {
    if (workshopState.mempool.length > 0 && !workshopState.currentMiner) {
        triggerMining();
    }
}, 45000);

// Initialize and start server
initializeBlockchain();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 Workshop Blockchain Server started!');
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log('📊 Dashboard: http://localhost:3000/basics');
    console.log('📊 Dashboard: http://localhost:3000/dashboard');
    console.log('👤 User interface: http://localhost:3000/user');
    console.log('⛏️ Miner interface: http://localhost:3000/miner');
    console.log('⛏️ Learning interface: http://localhost:3000/learn');
    console.log('');
    console.log('🎮 Ready for workshop participants!');
});