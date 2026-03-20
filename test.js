const { bcrypt } = require('bcrypt');
const { Sequelize } = require('sequelize');
const sequelize = new Sequelize('db_academia_v2', 'root', '5tgb6yhn', 
    {
        host: '127.0.0.1',
        dialect: 'mysql'
    });

// tb_usuarios
const Usuario = sequelize.define('tb_usuarios', {
    first_name: Sequelize.STRING,
    last_name: Sequelize.STRING,
    email: { 
        type: Sequelize.STRING, 
        unique: true,
        allowNull: false,
        validate: {
            isEmail: true
        }
    },
    password: { 
        type: Sequelize.STRING, 
        allowNull: false,
        validate: {
            len:[8,32]            
        }
    },
    role: {
        type: Sequelize.ENUM('ADMIN', 'PRO', 'STD'),
        allowNull: false,
        defaultValue: 'STD',
        validate: {
            isIn: [['ADMIN', 'PRO', 'STD']]
        }
    },
    phone: {
        type: Sequelize.CHAR(11),
        allowNull: true,
        validate: {
            is: /^[0-9]{11}$/
        }
    },
    birth_date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
        validate: {
            isDate: true,
            isBefore: new Date().toISOString().split('T')[0]
        }
    },
    actual_belt: {
        type: Sequelize.ENUM(
            'white', 
            'gray-white', 'gray', 'gray-black', 
            'yellow-white', 'yellow', 'yellow-black', 
            'orange-white', 'orange', 'orange-black', 
            'green-white', 'green', 'green-black', 
            'blue', 'purple', 'brown', 'black'),
        allowNull: false,
        defaultValue: 'white',
        validate: {
            isIn: [['white', 'gray-white', 'gray', 'gray-black', 'yellow-white', 'yellow', 'yellow-black', 
                'orange-white', 'orange', 'orange-black', 'green-white', 'green', 'green-black', 'blue', 'purple', 
                'brown', 'black']]
        }
    },
    actual_degree: {
        type: Sequelize.ENUM('0', '1', '2', '3', '4', '5', '6'),
        allowNull: false,
        defaultValue: '0',
        validate: {
            isIn: [['0', '1', '2', '3', '4', '5', '6']]
        }
    },
    wagi_size: {
        type: Sequelize.CHAR(3),
        allowNull: false,
    },
    zubon_size: {
        type: Sequelize.CHAR(3),
        allowNull: false,
    },
    obi_size: {
        type: Sequelize.CHAR(2),
        allowNull: false,
    },
    photo :{
        type: Sequelize.STRING,
        allowNull: true,
        validate: {
            is: /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i,
            len: [1, 255],
        },
        defaultValue: './uploads/users/default.jpg',
    },

    active : {
        type: Sequelize.BOOLEAN, 
        defaultValue: true,
    }
});

// sync() / sync({ alter: true }) / sync({ force: true })
// cria / altera / recria a tabela no banco de dados
// Usuario.sync({ force: true })

Usuario.create({
    first_name: 'Fábio',
    last_name: 'Klevinskas Lopes',
    email: 'fabioklopes@live.com',
    password: '5tgb6yhn',
    phone: '11975964612',
    birth_date: '1981-06-27',
    actual_belt: 'blue',
    actual_degree: '3',
    wagi_size: 'A3',
    zubon_size: 'A3',
    obi_size: 'A2',
});