/* libraries used */
/* eslint no-underscore-dangle: 0 */

const { expect, assert } = require('chai');
const { ethers } = require("hardhat"); // eslint-disable-line

const setup = require('../lib/setupItems');
const vals = require('../lib/valuesCommon');
const testVals = require('../lib/testValuesCommon');

/* Useful aliases */
const toBN = ethers.BigNumber.from;

let creatureAccessory;
let factory;
let lootBox;
let proxy;
let owner;
let userA; // eslint-disable-line
let userB;
let proxyForOwner;
let _others; // eslint-disable-line

/* Utility Functions */

// Not a function, the fields of the TransferSingle event.

const TRANSFER_SINGLE_FIELDS = [
  { type: 'address', name: '_operator', indexed: true },
  { type: 'address', name: '_from', indexed: true },
  { type: 'address', name: '_to', indexed: true },
  { type: 'uint256', name: '_id' },
  { type: 'uint256', name: '_amount' },
];

// Not a function, the keccak of the TransferSingle event.
//
const XferSingleInterface = new ethers.utils.Interface([
  {
    name: 'TransferSingle',
    type: 'event',
    inputs: TRANSFER_SINGLE_FIELDS,
  },
]);
const TRANSFER_SINGLE_SIG = XferSingleInterface.getEventTopic('TransferSingle');

const LootBoxOpenInterface = new ethers.utils.Interface([
  {
    name: 'LootBoxOpened',
    type: 'event',
    inputs: [
      { type: 'uint256', name: 'optionId', indexed: true },
      { type: 'address', name: 'buyer', indexed: true },
      { type: 'uint256', name: 'boxesPurchased' },
      { type: 'uint256', name: 'itemsMinted' },
    ],
  },
]);
const LOOTBOXOPENED_SIG = LootBoxOpenInterface.getEventTopic('LootBoxOpened');

const eventEmitted = (receipt, eventSig, time) => {
  const evts = receipt.events.filter((x) => x.topics.indexOf(eventSig) === 0);
  const parsed = evts.map((x) => LootBoxOpenInterface.parseLog(x));
  return [evts.length === time, parsed];
};

// Total the number of tokens in the transaction's emitted TransferSingle events
// Keep a total for each token id number (1:..2:..)
// and a total for *all* tokens as total:.

const totalEventTokens = (receipt, recipient) => {
  // total is our running total for all tokens
  const totals = { total: toBN(0) };
  // Parse each log from the event
  for (let i = 0; i < receipt.events.length; i += 1) {
    const raw = receipt.events[i];
    // Filter events so we process only the TransferSingle events
    // Note that topic[0] is the event signature hash
    if (raw.topics[0] === TRANSFER_SINGLE_SIG) {
      // Fields of TransferSingle
      const parsed = XferSingleInterface.parseLog(raw);
      // Exclude event signature hash from topics that we process here.
      raw.topics.slice(1);

      // Make sure the address that we are watching got the tokens.
      // Burnt tokens go to address zero, for example
      if (parsed.args._to === recipient.address) {
        // Keep a running total for each token id.
        const id = parsed.args._id;
        if (!totals[id]) {
          totals[id] = toBN(0);
        }
        const amount = toBN(parsed.args._amount);
        totals[id] = totals[id].add(amount);
        // Keep a running total for all token ids.
        totals.total = totals.total.add(amount);
      }
    }
  }
  return totals;
};

// Compare the token amounts map generated by totalEventTokens to a spec object.
// The spec should match the guarantees[] array for the option.

const compareTokenTotals = (totals, spec, option) => {
  Object.keys(spec).forEach((key) => {
    assert.isOk(
      // Because it's an Object.keys() value, key is a string.
      // We want that for the spec, as it is the correct key.
      // But to add one we want a number, so we parse it then add one.
      // Why do we want to add one?
      totals[parseInt(key, 10)] || toBN(0).gte(spec[key]),
      `Mismatch for option ${option} guarantees[${key}]`,
    );
  });
};

describe('DivaItemLootBox', () => {
  // To install the proxy mock and the attack contract we deploy our own
  // instances of all the classes here rather than using the ones that Truffle
  // deployed.
  before(async () => {
    /* Loading Contracts in this test */
    const LootBoxRandomness = await ethers.getContractFactory('LootBoxRandomness');
    const lootBoxRandomness = await LootBoxRandomness.deploy();

    const MockProxyRegistry = await ethers.getContractFactory('MockProxyRegistry');
    const DivaItem = await ethers.getContractFactory('DivaItem');
    const DivaItemFactory = await ethers.getContractFactory('DivaItemFactory');
    const DivaItemLootBox = await ethers.getContractFactory('DivaItemLootBox', {
      libraries: { LootBoxRandomness: lootBoxRandomness.address },
    });

    /* Defining Accounts */
    const accounts = await ethers.getSigners();
    [owner, userA, userB, proxyForOwner, ..._others] = accounts;

    /* Defining Contracts before test */
    proxy = await MockProxyRegistry.deploy();
    await proxy.setProxy(owner.address, proxyForOwner.address);
    creatureAccessory = await DivaItem.deploy(proxy.address);
    lootBox = await DivaItemLootBox.deploy(proxy.address);
    factory = await DivaItemFactory.deploy(
      proxy.address,
      creatureAccessory.address,
      lootBox.address,
    );
    await setup.setupAccessory(creatureAccessory, owner.address);
    await creatureAccessory.connect(owner).setApprovalForAll(factory.address, true);
    await creatureAccessory.transferOwnership(factory.address);
    await setup.setupAccessoryLootBox(lootBox, factory);
  });

  // Calls _mint()
  describe('#mint()', () => {
    it('should work for owner()', async () => {
      const option = toBN(vals.LOOTBOX_OPTION_BASIC);
      const amount = toBN(1);

      await expect(lootBox.connect(owner).mint(userB.address, option, amount, '0x00'))
        .to.emit(lootBox, 'TransferSingle')
        .withArgs(owner.address, testVals.ADDRESS_ZERO, userB.address, option, amount);
    });

    it('should work for proxy', async () => {
      const option = vals.LOOTBOX_OPTION_BASIC;
      const amount = toBN(1);
      await expect(
        lootBox.connect(proxyForOwner).mint(userB.address, option, amount, '0x00'),
      )
        .to.emit(lootBox, 'TransferSingle')
        .withArgs(
          proxyForOwner.address,
          testVals.ADDRESS_ZERO,
          userB.address,
          option,
          amount,
        );
    });

    it('should not be callable by non-owner() and non-proxy', async () => {
      const amount = toBN(1);
      await expect(
        lootBox
          .connect(userB)
          .mint(userB.address, vals.LOOTBOX_OPTION_PREMIUM, amount, '0x00'),
      ).to.be.revertedWith('Lootbox: owner or proxy only');
    });

    it('should not work for invalid option', async () => {
      const amount = toBN(1);
      await expect(
        lootBox
          .connect(owner)
          .mint(userB.address, vals.NO_SUCH_LOOTBOX_OPTION, amount, '0x00'),
      ).to.be.revertedWith('Lootbox: Invalid Option');
    });
  });

  describe('#unpack()', () => {
    it('should mint guaranteed class amounts for each option', async () => {
      for (let i = 0; i < vals.NUM_LOOTBOX_OPTIONS; i += 1) {
        const option = vals.LOOTBOX_OPTIONS[i];
        const amount = toBN(1);
        await lootBox
          .connect(proxyForOwner)
          .mint(userB.address, option, amount, '0x00');

        const tx = await lootBox.connect(userB).unpack(option, userB.address, amount);

        const receipt = await tx.wait();

        const [emitted, parsed] = eventEmitted(receipt, LOOTBOXOPENED_SIG, 1);

        assert.equal(emitted, true);
        assert.equal(parsed[0].args.optionId._hex, toBN(option)._hex);
        assert.equal(parsed[0].args.buyer, userB.address);
        assert.equal(
          parsed[0].args.itemsMinted._hex,
          toBN(vals.LOOTBOX_OPTION_AMOUNTS[option])._hex,
        );

        const totals = totalEventTokens(receipt, userB);
        assert.ok(totals.total.eq(toBN(vals.LOOTBOX_OPTION_AMOUNTS[option])));
        compareTokenTotals(totals, vals.LOOTBOX_OPTION_GUARANTEES[option], option);
      }
    });
  });
});
